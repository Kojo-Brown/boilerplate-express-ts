import { AppError } from '@/lib/errors';
import { formatETag } from '@/concurrency/etag';

/**
 * The ways a conditional write can fail on the precondition rather than on what
 * it was asking for.
 *
 * All three are `AppError` subclasses, so the translator registry already knows
 * how to render them and nothing needs registering — see
 * `lib/error-translators.ts`. The status codes are RFC 9110's (412) and RFC
 * 6585's (428); using anything else makes these responses uninterpretable to a
 * client library that has never seen this service, which is the entire reason
 * to speak HTTP's concurrency vocabulary instead of inventing one.
 */

/**
 * The route requires `If-Match` and the request did not carry one.
 *
 * 428, not 400: 428 exists precisely to say "your request is fine, but this
 * server will not accept it unconditionally", and it is the status a client
 * library keys on to go and fetch a validator. 400 says the request was
 * malformed, which it was not.
 *
 * Rejecting rather than defaulting to an unconditional write is the whole
 * guarantee. A route that silently accepts a write without a precondition
 * offers no protection against a lost update, and the client has no way to tell
 * which of the two it is talking to.
 */
export class PreconditionRequiredError extends AppError {
  constructor(headerName: string) {
    super(
      428,
      `This request requires an ${headerName} header carrying the version it expects`,
      'PRECONDITION_REQUIRED',
    );
    this.name = 'PreconditionRequiredError';
  }
}

/**
 * The header was present but is not a thing `If-Match` can be.
 *
 * Distinct from 412 on purpose. 412 is a statement about the *resource* — it is
 * at a version you did not name — and a client that acts on it will re-read and
 * retry. A malformed header is a statement about the *request*, and a client
 * told 412 for it would retry forever against an API that can never accept what
 * it is sending. A weak entity-tag lands here for the same reason.
 */
export class PreconditionMalformedError extends AppError {
  constructor(headerName: string, reason: string) {
    super(400, `Invalid ${headerName} header: ${reason}`, 'PRECONDITION_MALFORMED');
    this.name = 'PreconditionMalformedError';
  }
}

/**
 * The row exists and is at a version the request did not name.
 *
 * Carries the current validator in an `ETag` response header, which is what
 * turns recovery into one round trip instead of two: a client that trusts the
 * header can re-derive its patch and retry without a `GET`. RFC 9110 defines
 * `ETag` as "the current entity tag for the selected representation", and on a
 * 412 the selected representation is exactly the one the client mis-guessed.
 *
 * `currentVersion` is read in the same statement and snapshot as the failed
 * write, so it is the version that write actually lost to — not a follow-up
 * `SELECT` that could itself be overtaken.
 */
export class VersionConflictError extends AppError {
  constructor(public readonly currentVersion: number) {
    super(
      412,
      'The resource has changed since the version you supplied',
      'PRECONDITION_FAILED',
      { ETag: formatETag(currentVersion) },
    );
    this.name = 'VersionConflictError';
  }
}
