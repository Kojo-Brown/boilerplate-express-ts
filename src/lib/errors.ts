import type { ZodIssue } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    /**
     * Response headers this error is not merely accompanied by but *means*.
     *
     * `ETag` on a 412 and `Retry-After` on a 429 are not decoration: they are
     * the part of the answer a client acts on, and without them the status is a
     * dead end. The only other way to attach one is `res.setHeader` immediately
     * before the `throw`, which the idempotency middleware can do because it is
     * a middleware and holds a `Response` — and which a `RouteOperation`, whose
     * entire premise is that it never sees one, cannot.
     *
     * Applied by `errorMiddleware` after the translator chain, so an error
     * family carries its headers wherever it is thrown from.
     */
    public readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(public readonly issues: ZodIssue[]) {
    super(422, 'Validation failed', 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}
