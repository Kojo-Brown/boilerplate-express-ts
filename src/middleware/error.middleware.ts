import type { Request, Response, NextFunction } from 'express';
import { AppError, ValidationError } from '@/lib/errors';
import { sendFail } from '@/lib/response';

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ValidationError) {
    sendFail(res, 422, 'VALIDATION_ERROR', err.message, err.issues);
    return;
  }

  if (err instanceof AppError) {
    sendFail(res, err.statusCode, err.code ?? 'INTERNAL_ERROR', err.message);
    return;
  }

  if (err instanceof Error) {
    console.error('[unhandled error]', err.message, err.stack);
  }

  sendFail(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
