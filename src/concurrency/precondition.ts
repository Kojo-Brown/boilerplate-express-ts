import type { Request } from 'express';
import type { Precondition } from '@/concurrency/concurrency.types';
import {
  PreconditionMalformedError,
  PreconditionRequiredError,
} from '@/concurrency/concurrency.errors';
import { IF_MATCH_HEADER, parseIfMatch } from '@/concurrency/etag';

/**
 * `req.precondition` established, and said so in the type.
 *
 * The same move `Authenticated` makes for `req.auth`: an operation declared
 * over `WithPrecondition<...>` cannot be wired onto a pipeline that has not run
 * `requireIfMatch`, so "this route only accepts conditional writes" is checked
 * at the router rather than asserted in a comment above it.
 *
 * Note this is *not* a global augmentation of Express's `Request`. `auth` and
 * `scope` are declared globally because middleware outside any pipeline sets
 * them; nothing here does, so the property exists only on requests that went
 * through the step — which is precisely the claim being made.
 */
export type WithPrecondition<TReq extends Request> = TReq & { precondition: Precondition };

/**
 * Pipeline step: a write on this route must say which version it expects.
 *
 * ## Why the header is required rather than optional
 *
 * An unconditional `PUT` of a representation the client read a minute ago
 * silently discards every change made in between — the client believes it wrote
 * what it saw. Making `If-Match` optional means a route offers that protection
 * to careful clients and nothing to the rest, and no client can tell which kind
 * of server it is talking to.
 *
 * The cost that objection usually raises — "now every write needs a `GET`
 * first" — is not actually charged, because `If-Match: *` is a first-class
 * answer. A caller that genuinely does not care which version it overwrites
 * says so in one header and skips the read. What is required is that the
 * expectation be *stated*, not that it be narrow.
 *
 * ## Why it is a step and not a `(req, res, next)` middleware
 *
 * Because what it establishes is a type, and `next()` cannot carry one. The
 * operation behind this step reads `req.precondition` and passes it to a
 * conditional write; without the refinement, that property is either invented
 * on `Request` globally — describing every request in the process, including
 * the unconditional ones — or read through a `!` that no reviewer can check.
 *
 * Ordering against `validateParams` and `validateBody` is deliberately *not*
 * constrained: the precondition is about the row this request targets, and it
 * is independent of whether the body parsed. It is declared over a bare
 * `Request` so it composes either side of them.
 */
export function requireIfMatch<TReq extends Request>(req: TReq): WithPrecondition<TReq> {
  const header = req.get(IF_MATCH_HEADER);

  if (header === undefined || header.trim() === '') {
    throw new PreconditionRequiredError(IF_MATCH_HEADER);
  }

  const parsed = parseIfMatch(header);
  if (!parsed.ok) {
    throw new PreconditionMalformedError(IF_MATCH_HEADER, parsed.reason);
  }

  // `Object.assign` rather than `req.precondition = …`: the property is not on
  // Express's `Request`, and adding it there globally is the thing this type is
  // avoiding. Assign returns the intersection, so the refinement is produced by
  // the same expression that makes it true.
  return Object.assign(req, { precondition: parsed.precondition });
}
