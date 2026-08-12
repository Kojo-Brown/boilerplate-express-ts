import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema, ZodType } from 'zod';
import { ZodError } from 'zod';
import { ValidationError } from '@/lib/errors';
import type { WithBody, WithParams, WithQuery } from '@/lib/pipeline';

export interface ValidateSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Parse, or throw the API's validation error rather than Zod's.
 *
 * Shared by the classic middleware and the pipeline steps so there is one
 * answer to "what does a malformed request look like on the wire" — a 422 with
 * `issues`, produced in one place.
 */
export function parseOrThrow<TOut>(schema: ZodType<TOut>, value: unknown): TOut {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError(err.issues);
    }
    throw err;
  }
}

/**
 * Replace `req.query` with a parsed value.
 *
 * Express 5 moved `query` to a getter on the request prototype with no setter,
 * so the plain assignment this used to be threw
 * `TypeError: Cannot set property query of #<IncomingMessage> which has only a
 * getter` on a real request — in strict mode, which every compiled module is.
 * Unit tests built `req` as an object literal, which has no such accessor to
 * inherit, so the middleware looked fine right up until a route used it. No
 * router did, which is the only reason this was a landmine rather than an
 * outage.
 *
 * Defining an own property shadows the prototype's getter, which is the
 * documented way to substitute a parsed query in Express 5.
 */
function replaceQuery(req: Request, value: unknown): void {
  Object.defineProperty(req, 'query', {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function validate(schemas: ValidateSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body !== undefined) {
        req.body = parseOrThrow(schemas.body, req.body) as unknown;
      }
      if (schemas.query !== undefined) {
        replaceQuery(req, parseOrThrow(schemas.query, req.query));
      }
      if (schemas.params !== undefined) {
        req.params = parseOrThrow(schemas.params, req.params) as Record<string, string>;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Pipeline steps: parse one part of the request and narrow it in the type.
 *
 * Three steps rather than one `validate({ body, params })` because the type is
 * the deliverable. A single step taking an options object would have to compute
 * its output type from which keys were present, and the failure mode of getting
 * that wrong is silent: the pipeline claims a body it never parsed. Three
 * single-purpose steps each have one obvious return type, and composing them is
 * what pipelines are for.
 *
 * The assignment is what the narrowing describes: Zod's output is not the input
 * — coercions, defaults and stripped unknown keys all mean the parsed value
 * differs from what arrived — so the request has to carry the parsed value, not
 * merely be declared as though it did.
 */
export function validateBody<TBody>(
  schema: ZodType<TBody>,
): <TReq extends Request>(req: TReq) => WithBody<TReq, TBody> {
  return <TReq extends Request>(req: TReq): WithBody<TReq, TBody> => {
    const parsed = parseOrThrow(schema, req.body);
    req.body = parsed;
    return req as WithBody<TReq, TBody>;
  };
}

export function validateParams<TParams>(
  schema: ZodType<TParams>,
): <TReq extends Request>(req: TReq) => WithParams<TReq, TParams> {
  return <TReq extends Request>(req: TReq): WithParams<TReq, TParams> => {
    // Unlike `query`, `params` is an own property the router assigns per layer,
    // so a plain assignment holds for the rest of this route's stack.
    req.params = parseOrThrow(schema, req.params) as Request['params'];
    return req as WithParams<TReq, TParams>;
  };
}

export function validateQuery<TQuery>(
  schema: ZodType<TQuery>,
): <TReq extends Request>(req: TReq) => WithQuery<TReq, TQuery> {
  return <TReq extends Request>(req: TReq): WithQuery<TReq, TQuery> => {
    replaceQuery(req, parseOrThrow(schema, req.query));
    return req as WithQuery<TReq, TQuery>;
  };
}
