import type { Request, Response } from 'express';
import { IDEMPOTENCY_STORE } from '@/container/tokens';
import { requestFingerprint, scopeFor } from '@/idempotency/fingerprint';
import {
  IdempotencyKeyInProgressError,
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
} from '@/idempotency/idempotency.errors';
import type {
  IdempotencyClaim,
  IdempotencyStore,
  RecordedResponse,
} from '@/idempotency/idempotency.types';
import type { Authenticated } from '@/lib/pipeline';
import { scopeOf } from '@/middleware/container.middleware';

/** The header clients send. Named by draft-ietf-httpapi-idempotency-key-header. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Set on a replayed response, and the only way a client can tell that its
 * retry was absorbed rather than executed. Without it a duplicate submission
 * and a fresh one are indistinguishable on the wire, which makes the mechanism
 * impossible to observe in production or to assert on in a test.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** Long enough for a UUID or a ULID with room to spare; short enough to index. */
const MAX_KEY_LENGTH = 255;

/**
 * Printable, non-space ASCII. Excludes control characters — which would end up
 * in log lines and in a `Retry-After`-adjacent header echo — and whitespace,
 * where a trailing space makes two visually identical keys distinct and turns
 * a retry into a second execution.
 */
const KEY_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Statuses that must never be recorded, whatever else `isReplayable` allows.
 *
 * Each one means "not now" rather than "here is your answer", and replaying it
 * for the retention window would freeze a transient condition into a permanent
 * one: a client rate-limited once would keep receiving 429 for a day, from a
 * limiter that had long since let it through.
 */
const NEVER_REPLAYABLE: ReadonlySet<number> = new Set([408, 425, 429]);

export interface IdempotencyOptions {
  /**
   * Defaults to the container's `IDEMPOTENCY_STORE`, resolved per request.
   * Passed explicitly in tests, and by anything that wants a different
   * retention policy for one route.
   */
  store?: IdempotencyStore;
  /**
   * Whether a request without the header is rejected. Default `true`.
   *
   * `false` makes the guarantee opt-in per request, which is the right setting
   * for an endpoint that predates this middleware and has clients that do not
   * send the header yet. It is the wrong default: an endpoint that silently
   * accepts an unkeyed duplicate offers no guarantee at all, and the client
   * cannot tell which of the two it is talking to.
   */
  required?: boolean;
  /**
   * Which responses are worth replaying. Default: any 2xx/3xx/4xx that is not
   * in `NEVER_REPLAYABLE`.
   *
   * 4xx *is* recorded by default, and that is deliberate. A deterministic
   * rejection — 422 on a malformed body, 409 on a duplicate email — is the
   * answer to this request, and a retry that re-executes it re-does the work
   * of deciding. 5xx is excluded because there is no answer to record: the
   * request failed, and the claim is released so the client's next attempt can
   * take it.
   */
  isReplayable?: (status: number) => boolean;
}

/**
 * `Idempotency-Key` support as a pipeline step: claim the key, replay a stored
 * response, or run the request once and record what it answered.
 *
 * ## Why a step and not a classic `(req, res, next)` middleware
 *
 * Because the ordering is load-bearing and a middleware array cannot state it.
 * The key is scoped by the principal (see `scopeFor`), so this has to run
 * *after* authentication — mounted ahead of it, every caller shares the
 * `anonymous` scope and one client's key replays another's response body.
 * Declared over `Authenticated<Request>`, that ordering is a compile error
 * instead of a comment, exactly as `requireRoles` is. It is generic in `TReq`
 * so it can also sit after `validateParams`, and it deliberately fingerprints
 * `req.body` *before* validation so that a retry of a request the schema
 * rejects replays the same 422 rather than re-deciding it.
 *
 * ## Why the response is captured rather than the handler's return value
 *
 * A decorator in the `withCache` family sees `TResult`, and what has to be
 * replayed is the serialised response, not the value behind it. The two are
 * not interchangeable: `UserRow.created_at` is a `Date` on the way out and a
 * string once it has been through the record, so a store typed as `TResult`
 * would be claiming a shape it cannot return. Recording the response at the
 * boundary keeps the replay byte-identical to the original — which is the
 * entire promise — at the cost of the one thing in this file that is not
 * pretty: `res.json` and `res.end` are wrapped for the life of the request.
 *
 * The wrapper persists *before* flushing, never after. `res.on('finish')`
 * would be tidier and would record nothing in the one case that matters: a
 * client that disconnects mid-flush never fires `finish`, and that client is
 * precisely the one about to retry.
 */
export function idempotent(
  options: IdempotencyOptions = {},
): <TReq extends Authenticated<Request>>(req: TReq, res: Response) => Promise<TReq> {
  const { required = true, isReplayable = defaultIsReplayable } = options;

  return async <TReq extends Authenticated<Request>>(req: TReq, res: Response): Promise<TReq> => {
    const key = readKey(req, required);
    if (key === null) return req;

    const store = options.store ?? scopeOf(req).resolve(IDEMPOTENCY_STORE);
    const scope = scopeFor(req);
    const result = await store.claim({ scope, key, fingerprint: requestFingerprint(req.body) });

    switch (result.outcome) {
      case 'claimed':
        captureResponse(res, store, result.claim, isReplayable);
        return req;

      case 'replay':
        // Writing the response here is what ends the exchange: `compose` stops
        // the pipeline as soon as `responseIsOver(res)`, so the operation this
        // chain terminates in is never called.
        replayResponse(res, result.response);
        return req;

      case 'in_progress':
        // Advisory, and short: the original is either about to finish or about
        // to hit its own timeout. Set before the throw, while the error
        // middleware can still write headers.
        res.setHeader('Retry-After', '1');
        throw new IdempotencyKeyInProgressError();

      case 'mismatch':
        throw new IdempotencyKeyReusedError();
    }
  };
}

/** 2xx/3xx/4xx, minus the statuses that mean "ask again later". */
export function defaultIsReplayable(status: number): boolean {
  return status >= 200 && status < 500 && !NEVER_REPLAYABLE.has(status);
}

/**
 * The key, or `null` when the route allows requests without one.
 *
 * A malformed key is rejected rather than normalised. Trimming or truncating
 * silently maps two distinct keys onto one, and the client has no way to
 * discover that its second, different request was answered from the first
 * one's record.
 */
function readKey(req: Request, required: boolean): string | null {
  const header = req.get(IDEMPOTENCY_KEY_HEADER);

  if (header === undefined || header === '') {
    if (required) throw new IdempotencyKeyRequiredError(IDEMPOTENCY_KEY_HEADER);
    return null;
  }

  if (header.length > MAX_KEY_LENGTH) {
    throw new IdempotencyKeyInvalidError(`longer than ${MAX_KEY_LENGTH} characters`);
  }

  if (!KEY_PATTERN.test(header)) {
    throw new IdempotencyKeyInvalidError('must be printable ASCII with no spaces');
  }

  return header;
}

function replayResponse(res: Response, response: RecordedResponse): void {
  res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  res.status(response.status);

  if (!response.hasBody) {
    res.end();
    return;
  }

  res.json(response.body);
}

/**
 * Wraps the response so whatever this request answers is recorded under its
 * claim before it reaches the client.
 *
 * Both exits are covered because both are real: `res.json` for every enveloped
 * response, success or error, and `res.end` for the body-less ones (`204`).
 * A response written as a raw chunk is the third case and is deliberately not
 * recorded — there is nothing to store that a replay could reproduce
 * faithfully — so the claim is released and the retry re-executes.
 */
function captureResponse(
  res: Response,
  store: IdempotencyStore,
  claim: IdempotencyClaim,
  isReplayable: (status: number) => boolean,
): void {
  const originalJson = res.json.bind(res);
  const originalEnd = res.end.bind(res);
  let captured = false;

  const restore = (): void => {
    res.json = originalJson;
    res.end = originalEnd;
  };

  /**
   * Record, then flush. A store failure is logged and the response still goes
   * out: the work has already happened, and answering 500 to a caller whose
   * request succeeded — because the *bookkeeping* failed — trades a duplicate
   * for a lie. The unrecorded claim expires with its lease, so the client's
   * next retry re-executes rather than hanging.
   */
  const recordThenFlush = (response: RecordedResponse, flush: () => void): void => {
    const recorded = isReplayable(response.status)
      ? store.complete(claim, response)
      : store.release(claim);

    void recorded.then(
      (owned) => {
        if (!owned) {
          console.warn(
            `[idempotency] Claim on "${claim.key}" was taken over before its response could be recorded`,
          );
        }
        flush();
      },
      (err: unknown) => {
        console.error(`[idempotency] Recording the response for "${claim.key}" failed:`, err);
        flush();
      },
    );
  };

  res.json = (body: unknown): Response => {
    if (captured) return originalJson(body);
    captured = true;
    // Restored before the flush below, so `json`'s own internal call to `end`
    // reaches the real one rather than re-entering this wrapper.
    restore();
    recordThenFlush({ status: res.statusCode, hasBody: true, body }, () => {
      originalJson(body);
    });
    return res;
  };

  res.end = ((...args: unknown[]): Response => {
    if (captured) return applyEnd(originalEnd, res, args);
    captured = true;
    restore();

    // `end(cb)` and `end()` are body-less; anything else carries a chunk this
    // record cannot represent.
    const chunk = args[0];
    const hasChunk = chunk !== undefined && typeof chunk !== 'function';

    if (hasChunk) {
      void store.release(claim).catch((err: unknown) => {
        console.error(`[idempotency] Releasing "${claim.key}" failed:`, err);
      });
      return applyEnd(originalEnd, res, args);
    }

    recordThenFlush({ status: res.statusCode, hasBody: false }, () => {
      applyEnd(originalEnd, res, args);
    });
    return res;
    // `end` is declared with three overloads and a polymorphic `this` return,
    // and a single implementation signature cannot be written to satisfy all
    // of them. The cast is to the property's own type, so the wrapper is still
    // checked against every caller of `res.end`.
  }) as Response['end'];
}

/** `end` is overloaded, so its arguments cannot be spread through a variable. */
function applyEnd(end: Response['end'], res: Response, args: readonly unknown[]): Response {
  Reflect.apply(end, res, args);
  return res;
}
