import type { Request, Response, NextFunction } from 'express';
import { translateError } from '@/lib/error-translators';
import { sendFail } from '@/lib/response';

/**
 * Terminal error handler. Owns exactly two things: asking the translator
 * registry what the error means, and logging whatever nothing recognised.
 *
 * Adding support for a new error family is a `registerErrorTranslator` call in
 * the composition root — this function does not change.
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const translated = translateError(err);

  if (translated !== null) {
    sendFail(res, translated.statusCode, translated.code, translated.message, translated.issues);
    return;
  }

  if (err instanceof Error) {
    console.error('[unhandled error]', err.message, err.stack);
  }

  sendFail(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
