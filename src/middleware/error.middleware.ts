import type { Request, Response, NextFunction } from 'express';
import { AppError, ValidationError } from '@/lib/errors';

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ValidationError) {
    res.status(422).json({
      data: null,
      meta: null,
      error: { code: 'VALIDATION_ERROR', message: err.message, issues: err.issues },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      data: null,
      meta: null,
      error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message },
    });
    return;
  }

  if (err instanceof Error) {
    console.error('[unhandled error]', err.message, err.stack);
  }

  res.status(500).json({
    data: null,
    meta: null,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}
