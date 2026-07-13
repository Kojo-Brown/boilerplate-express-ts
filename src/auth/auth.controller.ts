import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from '@/auth/auth.service';
import { AppError } from '@/lib/errors';
import { sendOk, sendNoContent } from '@/lib/response';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export const authController = {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(422, 'Validation failed', 'VALIDATION_ERROR');
      }
      const result = await authService.login(parsed.data);
      sendOk(res, result);
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = refreshSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(422, 'Validation failed', 'VALIDATION_ERROR');
      }
      const result = await authService.refresh(parsed.data.refreshToken);
      sendOk(res, result);
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = logoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(422, 'Validation failed', 'VALIDATION_ERROR');
      }
      await authService.logout(parsed.data.refreshToken);
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  },
};
