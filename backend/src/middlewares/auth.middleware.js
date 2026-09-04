import jwt from 'jsonwebtoken';
import { config } from '../config/environment.js';
import { prisma } from '../config/database.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = req.cookies[config.accessTokenCookieName];

  if (!token) {
    return next(new ApiError(401, 'Authentication required. Please log in.'));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new ApiError(401, 'Token expired. Please log in again.'));
    }
    return next(new ApiError(401, 'Invalid token.'));
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { id: true, email: true, createdAt: true },
  });

  if (!user) {
    return next(new ApiError(401, 'User no longer exists.'));
  }

  req.user = user;
  next();
});

export { requireAuth };
