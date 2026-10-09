// Zod validation schemas for alert channel endpoints.
//
// Channel config is channel-type-specific and validated here at the API layer
// (not in the DB, which stores it as opaque JSON).
//
// EMAIL config:   { to: email string }
// WEBHOOK config: { url: https URL, secret?: string (min 16 chars if provided) }

import { z } from 'zod';

const channelTypes = ['EMAIL', 'WEBHOOK'];

// Per-type config schemas.
const emailConfigSchema = z.object({
  to: z
    .string({ required_error: 'to is required for EMAIL channels' })
    .email('to must be a valid email address'),
});

const webhookConfigSchema = z.object({
  url: z
    .string({ required_error: 'url is required for WEBHOOK channels' })
    .url('url must be a valid URL')
    .refine(
      (url) => url.startsWith('https://') || url.startsWith('http://'),
      'url must start with http:// or https://'
    ),
  secret: z
    .string()
    .min(16, 'Webhook secret must be at least 16 characters for adequate security')
    .optional(),
});

// Map from channel type to its config schema.
const configSchemas = {
  EMAIL:   emailConfigSchema,
  WEBHOOK: webhookConfigSchema,
};

// Create schema: requires type and validates config against the type-specific schema.
const createAlertChannelSchema = z
  .object({
    type: z.enum(channelTypes, {
      required_error: 'type is required',
      message: `type must be one of: ${channelTypes.join(', ')}`,
    }),
    config: z.record(z.unknown()),
    enabled: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    const configSchema = configSchemas[data.type];
    if (!configSchema) return;

    const result = configSchema.safeParse(data.config);
    if (!result.success) {
      result.error.issues.forEach((issue) => {
        ctx.addIssue({
          path: ['config', ...issue.path],
          message: issue.message,
          code: z.ZodIssueCode.custom,
        });
      });
    }
  });

// Update schema: only config and enabled may be changed; type is immutable.
const updateAlertChannelSchema = z
  .object({
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // config validation is deferred to the controller where we know the channel type.
    // The controller re-validates config against the type-specific schema.
    if (!data.config && data.enabled === undefined) {
      ctx.addIssue({
        path: [],
        message: 'At least one of config or enabled must be provided',
        code: z.ZodIssueCode.custom,
      });
    }
  });

export { createAlertChannelSchema, updateAlertChannelSchema, configSchemas };
