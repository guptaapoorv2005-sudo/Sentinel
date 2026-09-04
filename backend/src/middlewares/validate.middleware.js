// Validation middleware using Zod schemas.
//
// HOW IT WORKS:
// This is a higher-order function (a function that returns a function).
// You pass it a Zod schema, and it returns an Express middleware that:
//   1. Parses req.body against the schema
//   2. If valid: replaces req.body with the parsed/transformed data
//      (so things like .trim() and .toLowerCase() are applied)
//   3. If invalid: passes a structured ApiError to the error handler
//

import { ApiError } from '../utils/ApiError.js';

function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      // Zod provides structured errors. We extract them into a flat array of { field, message } objects for the API consumer.
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));

      return next(new ApiError(400, 'Validation failed', errors));
    }

    // Replace req.body with the parsed data.
    // This is important because Zod transforms (like .trim(), .toLowerCase(), and .default()) are applied during parsing.
    req.body = result.data;
    next();
  };
}

export { validate };
