// Zod validation schemas for authentication endpoints.
//
// WHY ZOD:
// - Express does not validate request bodies by default. If you send
//   { email: 123, password: true }, Express will happily pass it through.
// - Zod lets us define a schema that describes what the data MUST look like,
//   and it will throw structured errors if the data doesn't match.
// - This is far more robust than writing manual if-checks in every controller.
//

import { z } from 'zod';

const registerSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email format')
    .trim()
    .toLowerCase(),

  password: z
    .string({ required_error: 'Password is required' })
    .min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email format')
    .trim()
    .toLowerCase(),

  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password is required'),
});

const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(1, 'Current password is required').optional(),
    currentPassword: z.string().min(1, 'Current password is required').optional(),
    newPassword: z
      .string({ required_error: 'New password is required' })
      .min(8, 'New password must be at least 8 characters'),
    confirmPassword: z.string().optional(),
  })
  .refine((data) => Boolean(data.oldPassword || data.currentPassword), {
    message: 'Current password is required',
    path: ['oldPassword'],
  })
  .refine(
    (data) => !data.confirmPassword || data.confirmPassword === data.newPassword,
    {
      message: 'Password confirmation does not match new password',
      path: ['confirmPassword'],
    }
  );

export { registerSchema, loginSchema, changePasswordSchema };

