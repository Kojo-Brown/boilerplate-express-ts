import type { Request, Response, NextFunction } from 'express';
import { authService } from '@/auth/auth.service';
import { sendOk, sendNoContent } from '@/lib/response';
import type { LoginBody, LogoutBody, RefreshBody } from '@/auth/auth.schemas';

type BodyOf<T> = Request<Record<string, string>, unknown, T>;

/**
 * Transport only: call the service, shape the response, hand errors to the
 * error middleware. Bodies arrive already parsed by `validate()` on the router.
 */
export const authController = {
  async login(req: BodyOf<LoginBody>, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.login(req.body);
      sendOk(res, result);
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: BodyOf<RefreshBody>, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.refresh(req.body.refreshToken);
      sendOk(res, result);
    } catch (err) {
      next(err);
    }
  },

  async logout(req: BodyOf<LogoutBody>, res: Response, next: NextFunction): Promise<void> {
    try {
      await authService.logout(req.body.refreshToken);
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  },
};
