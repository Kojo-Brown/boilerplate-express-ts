/**
 * Failures the relay produces itself, as opposed to the ones a dispatcher
 * throws at it.
 *
 * None of them extend `AppError`: nothing here is on a request path, so there
 * is no status code to carry and no translator that should recognise them. They
 * exist to be *readable* — `last_error` on a dead-lettered row is what a person
 * has to work from at 3am, and "Error: undefined" is not a starting point.
 */

/** How much of a failure's text is kept on the row. */
export const MAX_LAST_ERROR_LENGTH = 1_000;

/**
 * The relay stopped waiting for a dispatcher.
 *
 * "Stopped waiting" and not "cancelled": a promise cannot be cancelled, so the
 * dispatch may still be running, and may still succeed, after this is thrown.
 * That is precisely the at-least-once case — the row is rescheduled while the
 * first attempt is potentially still in flight — and the reason the timeout is
 * a backstop set well above any healthy dispatch rather than a routine
 * deadline. What it actually protects is the claim: every message in a batch is
 * row-locked inside one open transaction, and an open transaction holds back
 * the cluster's `xmin` horizon.
 */
export class OutboxDispatchTimeoutError extends Error {
  constructor(
    readonly messageId: string,
    readonly eventName: string,
    readonly timeoutMs: number,
  ) {
    super(`Dispatch of ${eventName} (${messageId}) exceeded ${timeoutMs}ms`);
    this.name = 'OutboxDispatchTimeoutError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * A stored message whose name no subscriber in this process knows.
 *
 * The case is a rolling deploy, and it is the ordinary one rather than a
 * corruption: the new version enqueues `user.suspended` inside its transaction,
 * an old replica claims the row, and nothing in *that* process can act on it.
 * Retrying is right — the deploy finishes and the next claim succeeds — which
 * is why this is thrown rather than dead-lettered on sight. It reaches the
 * dead-letter only by exhausting the ladder, at which point the deploy has been
 * half-finished for minutes and somebody should hear about it.
 */
export class UnknownOutboxEventError extends Error {
  constructor(
    readonly messageId: string,
    readonly eventName: string,
  ) {
    super(
      `No subscriber contract for event "${eventName}" (${messageId}) in this build — ` +
        `either a rolling deploy is in progress or the event was removed`,
    );
    this.name = 'UnknownOutboxEventError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * One or more subscribers failed, so the message is not delivered.
 *
 * This is what makes the in-process bus a real delivery boundary rather than a
 * shrug: `publish` isolates handler failures by design and resolves regardless,
 * so a dispatcher that merely awaited it would report success for an event no
 * subscriber processed. The per-publish reporter collects them instead and this
 * error carries them into the ladder.
 *
 * The cost is stated on the way in: a retry redelivers to *every* subscriber,
 * including the ones that already succeeded. That is at-least-once with fan-out
 * and there is no version of it that redelivers to only the failed handler —
 * the bus does not know which of them are idempotent, and the outbox has one
 * row for the event rather than one per subscriber.
 */
export class OutboxDeliveryError extends Error {
  constructor(
    readonly messageId: string,
    readonly eventName: string,
    readonly failures: readonly { readonly handlerName: string; readonly error: Error }[],
  ) {
    const summary = failures
      .map(({ handlerName, error }) => `${handlerName}: ${error.message}`)
      .join('; ');
    super(
      `${failures.length} subscriber(s) failed for ${eventName} (${messageId}) — ${summary}`,
    );
    this.name = 'OutboxDeliveryError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * The one-line form of a failure that goes onto the row.
 *
 * Truncated, because `last_error` is written on every failed attempt and a
 * dispatcher that stringifies a response body into its message would otherwise
 * put a megabyte in a column the relay reads on every claim. The stack is
 * deliberately not stored: it describes the relay, which is the same three
 * frames every time, not the failure.
 */
export function describeFailure(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Non-error thrown: ${String(error)}`;

  return text.length > MAX_LAST_ERROR_LENGTH
    ? `${text.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`
    : text;
}
