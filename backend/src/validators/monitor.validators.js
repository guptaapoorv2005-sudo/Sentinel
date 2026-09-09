// Zod validation schemas for monitor endpoints.
//
// DESIGN DECISIONS:
// - `interval` minimum is 30 seconds, matching the PRD's smallest supported interval.
//   This balances useful monitoring frequency against system load.
// - `url` must start with http:// or https:// — we only support HTTP checks.
// - `expectedStatus` must be a valid HTTP status code (100-599).
// - `timeout` minimum is 1000ms (1 second), max 30000ms (30 seconds).
// - We use `.partial()` for the update schema so users can update
//   any subset of fields without providing all of them.

import { z } from 'zod';

const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const createMonitorSchema = z.object({
  name: z
    .string({ required_error: 'Name is required' })
    .min(1, 'Name cannot be empty')
    .max(255, 'Name too long'),

  url: z
    .string({ required_error: 'URL is required' })
    .url('Invalid URL format')
    .refine(
      (url) => url.startsWith('http://') || url.startsWith('https://'),
      'URL must start with http:// or https://'
    ),

  method: z
    .enum(httpMethods, { message: `Method must be one of: ${httpMethods.join(', ')}` })
    .default('GET'),

  interval: z
    .number({ invalid_type_error: 'Interval must be a number' })
    .int('Interval must be a whole number')
    .min(30, 'Minimum interval is 30 seconds')
    .max(86400, 'Maximum interval is 86400 seconds (24 hours)')
    .default(300),

  timeout: z
    .number({ invalid_type_error: 'Timeout must be a number' })
    .int('Timeout must be a whole number')
    .min(1000, 'Minimum timeout is 1000ms (1 second)')
    .max(30000, 'Maximum timeout is 30000ms (30 seconds)')
    .default(10000),

  expectedStatus: z
    .number({ invalid_type_error: 'Expected status must be a number' })
    .int('Expected status must be a whole number')
    .min(100, 'Status code must be between 100 and 599')
    .max(599, 'Status code must be between 100 and 599')
    .default(200),

  enabled: z
    .boolean()
    .default(true),
});

// For updates, all fields are optional — you only send what you want to change.
// This is called a "partial" schema in Zod.
const updateMonitorSchema = createMonitorSchema.partial();

// For the toggle endpoint, we only accept `enabled`.
const toggleMonitorSchema = z.object({
  enabled: z.boolean({ required_error: 'enabled is required' }),
});

export { createMonitorSchema, updateMonitorSchema, toggleMonitorSchema };
