import { createLogger } from '../utils/logger.js';

const logger = createLogger('error-handler');

const errorHandler = (err, req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  // Log the error with structured context
  logger.error({
    statusCode,
    message,
    url: req.originalUrl,
    method: req.method,
    ...(err.stack && { stack: err.stack }),
  }, 'Request error');

  const response = {
    statusCode,
    message,
    success: false,
    errors: err.errors || [],
  };

  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  return res.status(statusCode).json(response);
};

export { errorHandler };