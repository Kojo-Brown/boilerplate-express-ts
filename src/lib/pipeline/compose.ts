import type { Request, RequestHandler, Response } from 'express';
import type { RouteHandlerOptions } from '@/lib/route-decorators';
import { toRequestHandler } from '@/lib/route-decorators';
import type { RouteOperation } from '@/lib/route-decorators';
import type { BaseRequest, PipelineStep } from '@/lib/pipeline/types';
import { responseIsOver } from '@/lib/pipeline/types';

/**
 * The internal shape of a step once its types have done their work. Every
 * `use` narrows the caller's step to this before storing it, which is the one
 * cast in the module: the array is heterogeneous by construction — each entry
 * accepts what the entry before it returned — and no array type can say that.
 * Soundness comes from `use`, which is the only way in.
 */
type ErasedStep = (req: Request, res: Response) => Request | Promise<Request>;

/**
 * An ordered, immutable chain of steps, carrying the request type they have
 * collectively proved.
 *
 * Immutability is not decoration. The reason to have this at all is to name a
 * chain once (`authenticated`, `adminOnly`) and branch off it per route; if
 * `use` mutated, adding a `validateBody` to one route would silently add it to
 * every route derived from the same base, and the two most likely bases are
 * "authenticated" and "admin".
 */
export interface Pipeline<TReq extends Request> {
  /**
   * Append a step, returning a new pipeline typed by what that step proved.
   *
   * The step's own input type is what enforces ordering: `requireRoles` is
   * declared over an authenticated request, so putting it ahead of
   * `authenticate` does not compile.
   */
  use<TOut extends Request>(step: PipelineStep<TReq, TOut>): Pipeline<TOut>;

  /**
   * Terminate the pipeline with a `RouteOperation` and produce an ordinary
   * Express `RequestHandler`.
   *
   * The operation is the same request-in/value-out shape the route decorators
   * wrap, so a decorated stack drops in unchanged. `toRequestHandler` is built
   * once here rather than per request, so a `withCache` in that stack keeps one
   * store and one in-flight map for the life of the route.
   *
   * This is also what makes `toRequestHandler`'s cast from `Request` to the
   * operation's `TReq` honest for the first time. That cast was previously
   * justified by a `validate()` call sitting above it in a router — true, but
   * unchecked. Here the only way to produce a `Pipeline<Request<UserIdParams>>`
   * is to have put the step that parses those params into it.
   */
  handle<TResult>(
    operation: RouteOperation<TResult, TReq>,
    options?: RouteHandlerOptions<TResult>,
  ): RequestHandler;

  /** How many steps run before the operation. Reads as documentation in tests. */
  readonly size: number;
}

/**
 * Start a pipeline.
 *
 * ```ts
 * const authenticated = compose().use(authenticate);
 * const adminOnly = authenticated.use(requireRoles('admin'));
 *
 * router.get('/', adminOnly.handle(listUsers));
 * router.get('/:id', authenticated.use(validateParams(userIdParamsSchema)).handle(getUser));
 * ```
 */
export function compose(): Pipeline<BaseRequest> {
  return createPipeline<BaseRequest>([]);
}

function createPipeline<TReq extends Request>(steps: readonly ErasedStep[]): Pipeline<TReq> {
  return {
    size: steps.length,

    use<TOut extends Request>(step: PipelineStep<TReq, TOut>): Pipeline<TOut> {
      // Through `unknown` because the two disagree in the direction that is
      // the point: `ErasedStep` accepts any `Request`, while `step` accepts
      // only the refined one the pipeline has reached. That refinement is
      // established at run time by the steps already in the array, which is
      // precisely the invariant a type cannot carry across a heterogeneous
      // list — and `use` is the only door into that list.
      return createPipeline<TOut>([...steps, step as unknown as ErasedStep]);
    },

    handle<TResult>(
      operation: RouteOperation<TResult, TReq>,
      options: RouteHandlerOptions<TResult> = {},
    ): RequestHandler {
      const runOperation = toRequestHandler(operation, options);

      return (req, res, next) => {
        runSteps(steps, req, res).then((outcome) => {
          // A step wrote the response — a 429 from a rate limiter, a redirect
          // to a consent screen. There is nothing left to answer with.
          if (outcome === null) return;
          runOperation(outcome, res, next);
        }, next);
      };
    },
  };
}

/**
 * Run the chain in order. Resolves with the request the operation should
 * receive, or `null` when a step already answered the exchange.
 *
 * Sequential by definition: every step may depend on what the one before it
 * established, and half of them do.
 */
async function runSteps(
  steps: readonly ErasedStep[],
  req: Request,
  res: Response,
): Promise<Request | null> {
  let current = req;

  for (const step of steps) {
    if (responseIsOver(res)) return null;
    // Steps refine the request they were given and hand it back; reassigning
    // rather than ignoring the return value means a step that swaps the object
    // is honoured, and a step that forgets to return one does not compile.
    current = await step(current, res);
  }

  return responseIsOver(res) ? null : current;
}
