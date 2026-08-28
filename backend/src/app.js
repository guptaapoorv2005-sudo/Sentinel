import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { config } from './config/environment.js';
import { createLogger } from './utils/logger.js';
import { ApiResponse } from './utils/ApiResponse.js';
import { ApiError } from './utils/ApiError.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { prisma, testDatabaseConnection } from './config/database.js';
import { testRedisConnection } from './config/redis.js';

const logger = createLogger('api');

const app = express();

app.use(helmet());
app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- Request logging ---
// pino-http automatically logs every incoming request with:
// - HTTP method, URL, status code
// - Response time in milliseconds
// - Request ID (for correlating logs within a single request)
// app.use(pinoHttp({ logger }));


app.get('/api/v1/health', (req, res) => {
  res.status(200).json(new ApiResponse(
    200,
    {
      service: 'sentinel-api',
      environment: config.nodeEnv,
      timestamp: new Date().toISOString(),
    },
    'Server is healthy.',
  ));
});

app.get('/api/v1/ready', async (req, res) => {
  const checks = {
    database: 'unknown',
    redis: 'unknown',
  };

  try {
    await testDatabaseConnection();
    checks.database = 'connected';
  } catch {
    checks.database = 'unreachable';
  }

  try {
    await testRedisConnection();
    checks.redis = 'connected';
  } catch {
    checks.redis = 'unreachable';
  }

  const allHealthy = checks.database === 'connected' && checks.redis === 'connected';

  const status = allHealthy ? 200 : 503;
  res.status(status).json(new ApiResponse(
    status,
    {
      ready: allHealthy,
      ...checks,
      timestamp: new Date().toISOString(),
    },
    allHealthy ? 'All dependencies healthy.' : 'One or more dependencies unreachable.',
  ));
});

// --- Import routes ---
// (Routes will be added in Phase 1)

// --- Use routes ---

app.use((req, _res, next) => {
  next(new ApiError(404, 'Route not found: ' + req.originalUrl));
});

app.use(errorHandler);

export { app, prisma };
