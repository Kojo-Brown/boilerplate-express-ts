import { AppError } from '@/lib/errors';

/**
 * The ways a request can fail on the key itself rather than on what it was
 * asking for.
 *
 * All four are `AppError` subclasses, so the translator registry already knows
 * how to render them and nothing needs to be registered — see
 * `lib/error-translators.ts`. The status codes follow
 * draft-ietf-httpapi-idempotency-key-header, which is the only thing making
 * these responses interpretable by a client library that has never seen this
 * service.
 */

/** The route requires a key and the request did not carry one. */
export class IdempotencyKeyRequiredError extends AppError {
  constructor(headerName: string) {
    super(400, `This request requires an ${headerName} header`, 'IDEMPOTENCY_KEY_REQUIRED');
    this.name = 'IdempotencyKeyRequiredError';
  }
}

/**
 * The header was present but unusable.
 *
 * Rejected rather than sanitised: a key that is silently truncated or
 * normalised is a key two different requests can end up sharing, and the client
 * has no way to discover it happened.
 */
export class IdempotencyKeyInvalidError extends AppError {
  constructor(reason: string) {
    super(400, `Invalid idempotency key: ${reason}`, 'IDEMPOTENCY_KEY_INVALID');
    this.name = 'IdempotencyKeyInvalidError';
  }
}

/**
 * The first request holding this key has not answered yet.
 *
 * 409 rather than blocking until it finishes: waiting would hold a connection
 * for as long as the original takes, and a client retrying because it *timed
 * out* is exactly the client least able to wait again. The answer is
 * "retry shortly", carried by a `Retry-After` the middleware sets alongside it.
 */
export class IdempotencyKeyInProgressError extends AppError {
  constructor() {
    super(
      409,
      'A request with this idempotency key is still being processed',
      'IDEMPOTENCY_KEY_IN_PROGRESS',
    );
    this.name = 'IdempotencyKeyInProgressError';
  }
}

/**
 * The key is live and was first used for a different body.
 *
 * This is the check that keeps the mechanism from becoming a hazard. Without
 * it, a client that reuses a key by accident gets the *first* request's
 * response for a second, materially different request — a silent, successful
 * lie. 422 says the key is the problem, not the payload.
 */
export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(
      422,
      'This idempotency key was already used for a request with a different payload',
      'IDEMPOTENCY_KEY_REUSED',
    );
    this.name = 'IdempotencyKeyReusedError';
  }
}

/**
 * The store could not establish who owns the key within its retry budget.
 *
 * Distinct from 409 on purpose. A 409 is a statement of fact — another request
 * holds this key — and a client library is entitled to act on it. This is the
 * absence of that fact: every read lost a race with a concurrent purge or
 * takeover. Reporting it as a 409 would attribute the request to a competitor
 * that may not exist; 503 says the service could not decide and the request is
 * safe to send again.
 */
export class IdempotencyStoreContentionError extends AppError {
  constructor(attempts: number) {
    super(
      503,
      `Could not resolve the state of this idempotency key after ${attempts} attempts`,
      'IDEMPOTENCY_CONTENTION',
    );
    this.name = 'IdempotencyStoreContentionError';
  }
}
