import type { Request, Response, NextFunction } from 'express';
import { userRepository } from '@/users/users.repository';
import { AppError } from '@/lib/errors';
import { sendOk, sendCreated, sendNoContent } from '@/lib/response';
import type { CreateUserBody, UpdateUserBody, UserIdParams } from '@/users/users.schemas';

type WithParams<P> = Request<P>;
type WithParamsAndBody<P, B> = Request<P, unknown, B>;
type WithBody<B> = Request<Record<string, string>, unknown, B>;

/**
 * Transport only. Params and bodies arrive already parsed by `validate()` on
 * the router, so nothing here re-derives them or hand-rolls a 422.
 */
export const usersController = {
  async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await userRepository.findAll({ orderBy: 'created_at', order: 'ASC' });
      sendOk(res, users);
    } catch (err) {
      next(err);
    }
  },

  async getById(req: WithParams<UserIdParams>, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await userRepository.findById(req.params.id);
      if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
      sendOk(res, user);
    } catch (err) {
      next(err);
    }
  },

  async create(req: WithBody<CreateUserBody>, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await userRepository.create(req.body);
      sendCreated(res, user);
    } catch (err) {
      next(err);
    }
  },

  async update(
    req: WithParamsAndBody<UserIdParams, UpdateUserBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const user = await userRepository.update(req.params.id, req.body);
      if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
      sendOk(res, user);
    } catch (err) {
      next(err);
    }
  },

  async remove(req: WithParams<UserIdParams>, res: Response, next: NextFunction): Promise<void> {
    try {
      const deleted = await userRepository.delete(req.params.id);
      if (!deleted) throw new AppError(404, 'User not found', 'NOT_FOUND');
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  },
};
