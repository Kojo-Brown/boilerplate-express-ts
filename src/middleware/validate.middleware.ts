import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { ZodError } from 'zod';
import { ValidationError } from '@/lib/errors';

export interface ValidateSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidateSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body !== undefined) {
        req.body = schemas.body.parse(req.body) as unknown;
      }
      if (schemas.query !== undefined) {
        req.query = schemas.query.parse(req.query) as Record<string, string>;
      }
      if (schemas.params !== undefined) {
        req.params = schemas.params.parse(req.params) as Record<string, string>;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new ValidationError(err.issues));
      } else {
        next(err);
      }
    }
  };
}
