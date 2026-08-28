import { app, prisma } from './app.js';
import { redis } from './config/redis.js';
import { config } from './config/environment.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('server');

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'Sentinel API started');
});

// WHY GRACEFUL SHUTDOWN MATTERS:
// When Docker stops a container, it sends SIGTERM first and waits
// (default 10 seconds) before sending SIGKILL.
// If we handle SIGTERM, we can:
// - Stop accepting new requests
// - Let in-flight requests finish
// - Close database connections cleanly
// - Close Redis connections cleanly
// Without this, clients get dropped connections and database connections leak.

// --- Graceful Shutdown ---
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;  // Prevent double shutdown
  isShuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received. Closing gracefully...');

  // 1. Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      // 2. Close database connection pool
      await prisma.$disconnect();
      logger.info('Database connection closed');
    } catch (err) {
      logger.error({ err: err.message }, 'Error closing database connection');
    }

    try {
      // 3. Close Redis connection
      await redis.quit();
      logger.info('Redis connection closed');
    } catch (err) {
      logger.error({ err: err.message }, 'Error closing Redis connection');
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  });

  // If graceful shutdown takes too long, force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown — graceful shutdown timed out');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Unhandled Rejection / Exception ---
// Log them so they're visible in structured logs, then exit.
// In production, a process manager (Docker, PM2) should restart us.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});