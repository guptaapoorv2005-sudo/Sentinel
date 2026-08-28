// Structured logger using Pino.
//
// WHY PINO:
// - Outputs structured JSON logs (machine-parseable)
// - Each log entry has: timestamp, level, component, message
// - In a distributed system with multiple workers, you need to search/filter
//   logs programmatically. console.log("something happened") won't scale.
// - Pino is the fastest Node.js logger — important when workers log at high volume.
//
// USAGE:
//   import { createLogger } from '../utils/logger.js';
//   const logger = createLogger('api');       // component name
//
// The component name (e.g., 'api', 'scheduler', 'worker') lets you filter
// logs from different Sentinel processes when they're all writing to the
// same log stream.

import pino from 'pino';
import { config } from '../config/environment.js';

// Base logger configuration
const loggerOptions = {
  level: config.nodeEnv === 'production' ? 'info' : 'debug',

  // In development, use pino-pretty for human-readable output.
  // In production, use raw JSON for log aggregation tools.
  ...(config.logFormat === 'pretty' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
};

// Create a child logger with a component name.
// Child loggers inherit the parent config but add a fixed field.
// Every log line from this logger will include { component: 'api' } (or whatever name).
function createLogger(component) {
  return pino(loggerOptions).child({ component });
}

// Default logger for top-level / startup messages
const logger = createLogger('sentinel');

export { logger, createLogger };
