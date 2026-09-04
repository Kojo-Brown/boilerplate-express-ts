/**
 * Failures the stream consumer produces itself, and the two Redis replies it
 * has to recognise as *expected* rather than as errors.
 *
 * None of them extend `AppError`: nothing here is on a request path, so there
 * is no status code to carry and no translator that should recognise them.
 */

/**
 * Redis answers `XGROUP CREATE` on an existing group with an error, not with a
 * no-op. That makes "create the group if it is missing" — which every consumer
 * does on every boot — a call that fails on all boots after the first.
 *
 * There is no `IF NOT EXISTS`. `XINFO GROUPS` first is worse rather than
 * better: it is a check-then-act across a network, so two replicas starting
 * together still race, and the loser gets this reply anyway. So the reply *is*
 * the idempotence, and this is the predicate that says so.
 *
 * Matched on the error's message prefix because that is the whole of the
 * protocol: RESP error replies are a string whose first word is the code, and
 * `ioredis` surfaces them as an `Error` carrying that string. Anchored with
 * `startsWith` rather than `includes` so an error *quoting* a group name that
 * happens to contain the word is not swallowed.
 */
export function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('BUSYGROUP');
}

/**
 * The stream or the group is gone.
 *
 * Not a corruption and not always an operator error: `XGROUP DESTROY`, a
 * `FLUSHDB` against a shared development instance, an expired key, or a
 * failover to a replica that never received the `XGROUP CREATE` all produce it.
 * It is recoverable in exactly one way — create the group again — which is why
 * the worker treats it as a signal to re-run `ensureGroup` rather than as a
 * reason to die.
 *
 * Recreating loses the group's cursor: a group made at `$` starts from "now",
 * so entries added while the group did not exist are never delivered. That is
 * not something the consumer can fix, and it is the reason the recreation is
 * logged loudly rather than silently.
 */
export function isNoGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOGROUP');
}

/**
 * A reply did not have the shape the parser expects.
 *
 * It names a *server*, not a bug in the caller, which is why it is worth its
 * own type: stream reply shapes are version-dependent — `XAUTOCLAIM` grew a
 * third reply element in Redis 7.0, and `XPENDING`'s summary answers with a
 * null tail rather than an empty one — so "this is not the reply this code was
 * written against" is a real, diagnosable condition. Left as a `TypeError` from
 * an index into `unknown`, it would instead surface as `undefined` moving
 * through the worker until something unrelated failed on it.
 */
export class UnexpectedRedisReplyError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(`Unexpected ${command} reply: ${detail}`);
    this.name = 'UnexpectedRedisReplyError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * A handler did not come back inside its budget.
 *
 * "Did not come back" and not "was cancelled": a promise cannot be cancelled,
 * so the handler may still be running, and may still succeed, after this is
 * thrown. The entry is therefore left unacknowledged and will be redelivered —
 * which is the at-least-once contract, stated at the point where it is earned.
 *
 * What the timeout actually protects is the loop. A handler that never resolves
 * would otherwise stop this consumer forever while its entries sit in the
 * pending list, idle-timing their way into some *other* consumer's claim — so
 * the work would run twice anyway, with the first copy still holding a
 * connection and the process refusing to shut down.
 */
export class StreamHandlerTimeoutError extends Error {
  constructor(
    readonly entryId: string,
    readonly timeoutMs: number,
  ) {
    super(`Handler for stream entry ${entryId} exceeded ${timeoutMs}ms`);
    this.name = 'StreamHandlerTimeoutError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * An entry that cannot be decoded into an envelope.
 *
 * This is the one failure the worker must *not* retry. Every other handler
 * failure is plausibly transient — a dependency is down, a lock was contended —
 * and redelivery is the answer. A field that is not JSON, or an entry missing
 * the `name` field entirely, will fail identically on every attempt until the
 * delivery ceiling parks it, having consumed the whole ladder to learn what was
 * knowable on the first read. So a decode failure parks immediately.
 *
 * The cause is a producer, which is why the message names the field rather than
 * the entry: whoever is investigating has to go and look at the writer.
 */
export class MalformedStreamEntryError extends Error {
  constructor(
    readonly entryId: string,
    readonly detail: string,
  ) {
    super(`Stream entry ${entryId} is not a valid event envelope: ${detail}`);
    this.name = 'MalformedStreamEntryError';
    Error.captureStackTrace(this, this.constructor);
  }
}
