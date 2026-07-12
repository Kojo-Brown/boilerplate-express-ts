import type { ZodIssue } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
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
