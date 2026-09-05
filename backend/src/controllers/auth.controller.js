import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../config/database.js';
import { config } from '../config/environment.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const logger = createLogger('auth');

const BCRYPT_ROUNDS = 12;

const googleClient = new OAuth2Client(config.googleClientId);

function setAuthCookies(res, accessToken, refreshToken) {
  const cookieOptions = {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
  };

  res.cookie(config.accessTokenCookieName, accessToken, {
    ...cookieOptions,
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  });

  if (refreshToken) {
    res.cookie(config.refreshTokenCookieName, refreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
  }
}

function generateAccessToken(userId) {
  return jwt.sign({ userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

function generateRefreshToken(userId) {
  return jwt.sign({ userId }, config.refreshTokenSecret, {
    expiresIn: config.refreshTokenExpiresIn,
  });
}

const register = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return next(new ApiError(409, 'Email already registered'));
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      authProvider: 'LOCAL'
    },
    select: { id: true, email: true, createdAt: true },
  });

  const accessToken = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken },
  });

  setAuthCookies(res, accessToken, refreshToken);

  // logger.info({ userId: user.id, email: user.email }, 'User registered');

  res.status(201).json(new ApiResponse(201, { user }, 'Registration successful'));
});

const login = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.authProvider !== 'LOCAL') {
    return next(new ApiError(401, 'Invalid email or password'));
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);

  if (!passwordValid) {
    return next(new ApiError(401, 'Invalid email or password'));
  }

  const accessToken = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken },
  });

  setAuthCookies(res, accessToken, refreshToken);

  // logger.info({ userId: user.id }, 'User logged in');

  res.status(200).json(new ApiResponse(200, {
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
  }, 'Login successful'));
});

const googleLogin = asyncHandler(async (req, res, next) => {
  const { idToken } = req.body;

  if (!idToken) {
    return next(new ApiError(400, 'Missing idToken'));
  }

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken,
      audience: config.googleClientId,
    });
  } catch (error) {
    logger.warn({ error: error.message }, 'Google token verification failed');
    return next(new ApiError(401, 'Invalid Google token'));
  }

  const payload = ticket.getPayload();
  const email = payload.email;
  const googleId = payload.sub;

  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        googleId,
        authProvider: 'GOOGLE',
      }
    });
    logger.info({ userId: user.id, email }, 'User registered via Google');
  } else {
    if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId }
      });
    }
  }

  const accessToken = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken },
  });

  setAuthCookies(res, accessToken, refreshToken);

  logger.info({ userId: user.id }, 'User logged in via Google');

  res.status(200).json(new ApiResponse(200, {
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
  }, 'Google login successful'));
});

const refresh = asyncHandler(async (req, res, next) => {
  const incomingRefreshToken = req.cookies[config.refreshTokenCookieName];

  if (!incomingRefreshToken) {
    return next(new ApiError(401, 'Unauthorized request'));
  }

  try {
    const decodedToken = jwt.verify(incomingRefreshToken, config.refreshTokenSecret);
    const user = await prisma.user.findUnique({ where: { id: decodedToken.userId } });

    if (!user) {
      return next(new ApiError(401, 'Invalid refresh token'));
    }

    if (incomingRefreshToken !== user.refreshToken) {
      return next(new ApiError(401, 'Refresh token is expired or used'));
    }

    const accessToken = generateAccessToken(user.id);
    const newRefreshToken = generateRefreshToken(user.id);

    // Rotate refresh token
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    });

    setAuthCookies(res, accessToken, newRefreshToken);

    res.status(200).json(new ApiResponse(200, null, 'Access token refreshed'));
  } catch (error) {
    return next(new ApiError(401, 'Invalid or expired refresh token'));
  }
});

const me = asyncHandler(async (req, res, next) => {
  res.status(200).json(new ApiResponse(200, { user: req.user }));
});

const logout = asyncHandler(async (req, res, next) => {
  let userId = req.user?.id;

  if (!userId) {
    const incomingRefreshToken = req.cookies[config.refreshTokenCookieName];
    if (incomingRefreshToken) {
      try {
        const decodedToken = jwt.verify(incomingRefreshToken, config.refreshTokenSecret, { ignoreExpiration: true });
        userId = decodedToken.userId;
      } catch (err) {
        // Ignore if we can't decode it
      }
    }
  }

  if (userId) {
    await prisma.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });
  }

  res.clearCookie(config.accessTokenCookieName);
  res.clearCookie(config.refreshTokenCookieName);
  res.status(200).json(new ApiResponse(200, null, 'Logged out'));
});

const changePassword = asyncHandler(async (req, res, next) => {
  const currentPassword = req.body.oldPassword || req.body.currentPassword;
  const { newPassword } = req.body;

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
  });

  if (!user) {
    return next(new ApiError(404, 'User not found'));
  }

  if (!user.passwordHash) {
    return next(
      new ApiError(400, 'Accounts using social login do not have a password set')
    );
  }

  const isPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isPasswordValid) {
    return next(new ApiError(400, 'Current password is incorrect'));
  }

  if (currentPassword === newPassword) {
    return next(
      new ApiError(400, 'New password must be different from current password')
    );
  }

  const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const accessToken = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: newPasswordHash,
      refreshToken,
    },
  });

  setAuthCookies(res, accessToken, refreshToken);

  // logger.info({ userId: user.id }, 'User changed password');

  res.status(200).json(
    new ApiResponse(200, null, 'Password changed successfully')
  );
});

export { register, login, googleLogin, refresh, me, logout, changePassword };

