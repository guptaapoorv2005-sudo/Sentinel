const requiredVars = [
  'PORT',
  'DATABASE_URL',
  'NODE_ENV',
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
  };
}

const config = loadEnvironment();

export { config };
