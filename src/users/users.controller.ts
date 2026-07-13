import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { userRepository } from '@/users/users.repository';
import { AppError } from '@/lib/errors';
import { sendOk, sendCreated, sendNoContent } from '@/lib/response';

const createUserSchema = z.object({
  email: z.string().email(),
  password_hash: z.string().optional().nullable(),
  roles: z.array(z.string()).optional(),
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  roles: z.array(z.string()).optional(),
});

export const usersController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await userRepository.findAll({ orderBy: 'created_at', order: 'ASC' });
      sendOk(res, users);
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await userRepository.findById(req.params['id'] as string);
      if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
      sendOk(res, user);
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(422, 'Validation failed', 'VALIDATION_ERROR');
      const user = await userRepository.create(parsed.data);
      sendCreated(res, user);
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(422, 'Validation failed', 'VALIDATION_ERROR');
      const user = await userRepository.update(req.params['id'] as string, parsed.data);
      if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
      sendOk(res, user);
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const deleted = await userRepository.delete(req.params['id'] as string);
      if (!deleted) throw new AppError(404, 'User not found', 'NOT_FOUND');
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  },
};
