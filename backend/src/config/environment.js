const requiredVars = [
  'PORT',
  'DATABASE_URL',
  'NODE_ENV',
  'JWT_SECRET',
  'REFRESH_TOKEN_SECRET',
];

const optionalVars = {
  CORS_ORIGIN: 'http://localhost:5173',
  REDIS_URL: 'redis://localhost:6379',
};

function loadEnvironment() {
  const missing = requiredVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    // We use console.error here because the logger depends on config,
    // so it may not be initialized yet.
    console.error(
      `FATAL: Missing required environment variables: ${missing.join(', ')}`
    );
    process.exit(1);
  }

  return {
    port: parseInt(process.env.PORT, 10),
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    corsOrigin: process.env.CORS_ORIGIN || optionalVars.CORS_ORIGIN,
    redisUrl: process.env.REDIS_URL || optionalVars.REDIS_URL,
    logFormat: process.env.LOG_FORMAT || (process.env.NODE_ENV === 'development' ? 'pretty' : 'json'),

    // JWT authentication config
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: '1d', // Access token expiry (1 day)
    refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET,
    refreshTokenExpiresIn: '7d', // Refresh token expiry (7 days)
    accessTokenCookieName: 'sentinel_access_token',
    refreshTokenCookieName: 'sentinel_refresh_token',
    googleClientId: process.env.GOOGLE_CLIENT_ID, // Optional for now
  };
}

const config = loadEnvironment();

export { config };
