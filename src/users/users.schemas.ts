import { z } from 'zod';

export const userIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const createUserBodySchema = z.object({
  email: z.string().email(),
  password_hash: z.string().optional().nullable(),
  roles: z.array(z.string()).optional(),
});

export const updateUserBodySchema = z.object({
  email: z.string().email().optional(),
  roles: z.array(z.string()).optional(),
});

export type UserIdParams = z.infer<typeof userIdParamsSchema>;
export type CreateUserBody = z.infer<typeof createUserBodySchema>;
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
