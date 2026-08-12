import type { Request, Response } from 'express';

/**
 * Where every pipeline starts.
 *
 * Two departures from Express's default `Request`, both deliberate:
 *
 * - `body` and `query` are `unknown` rather than `any`. `any` is why
 *   `req.body.email` typechecks on a route with no validation at all — the
 *   defect the whole exercise is aimed at. `unknown` makes an unparsed body
 *   unusable until a step has narrowed it, which is the point.
 * - The refinements below are *intersections*, so they only compose if the
 *   thing being intersected is not `any`: `any & CreateUserBody` is `any`, and
 *   the body type a step just proved would vanish. Starting from `unknown` is
 *   what makes `WithBody` mean anything.
 *
 * `params` and `query` keep their Express defaults so an un-narrowed pipeline
 * still behaves like the Express everyone knows.
 */
export type BaseRequest = Request<Request['params'], unknown, unknown, Request['query']>;

/**
 * One stage of a pipeline: request in, *refined* request out.
 *
 * There is no `next`. `next()` overloads three unrelated signals onto one
 * callback — continue, fail, skip the rest of this route — and Express cannot
 * tell you which one a middleware meant, cannot stop it sending two of them,
 * and cannot report the type a middleware just established. A step continues
 * by returning, fails by throwing, and states what it proved in its return
 * type.
 *
 * The refinement is an assertion the step is trusted to make good on, exactly
 * as an assertion function is: `authenticate` returns `TReq & { auth }` because
 * it assigned `req.auth` a line earlier. What the type buys is that every
 * *consumer* of that claim is checked — the steps after it and the operation
 * at the end.
 *
 * `TIn` sits in a parameter position, so `strictFunctionTypes` checks it
 * contravariantly and ordering becomes a compile error rather than a comment:
 * a step declared over `Request & { auth }` cannot be `use`d on a pipeline that
 * has not authenticated yet.
 */
export type PipelineStep<TIn extends Request, TOut extends Request = TIn> = (
  req: TIn,
  res: Response,
) => TOut | Promise<TOut>;

/**
 * `req.auth` promoted from optional to present.
 *
 * The global augmentation has to type `auth` as optional because it describes
 * every request in the process, including the ones that never reach an auth
 * middleware. That optionality then follows the request into handlers that
 * cannot be reached without a token, where it is answered with `!` or a check
 * that can never fail. Intersecting a required property with the optional one
 * makes it required for this request only.
 */
export type Authenticated<TReq extends Request> = TReq & { auth: NonNullable<Request['auth']> };

/** `req.params` narrowed to what a schema proved. */
export type WithParams<TReq extends Request, TParams> = TReq & { params: TParams };

/** `req.body` narrowed to what a schema proved. */
export type WithBody<TReq extends Request, TBody> = TReq & { body: TBody };

/** `req.query` narrowed to what a schema proved. */
export type WithQuery<TReq extends Request, TQuery> = TReq & { query: TQuery };

/**
 * True once the response has been written and nothing further should run.
 *
 * A pipeline stops on this rather than on a sentinel return value because the
 * steps that end an exchange early are mostly *not* ours — a rate limiter
 * answering 429, passport redirecting to a consent screen, a conditional-GET
 * middleware sending 304. None of them can be taught a new protocol, and all of
 * them announce themselves the same way.
 */
export function responseIsOver(res: Response): boolean {
  return res.headersSent || res.writableEnded;
}
