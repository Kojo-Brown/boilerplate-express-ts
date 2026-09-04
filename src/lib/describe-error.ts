/**
 * The one-line form of a failure, for the places that store one.
 *
 * It lives here rather than in `@/outbox` because two subsystems now write a
 * failure into a durable record a person reads later — `outbox_messages.last_error`
 * and the reason stamped onto a parked Redis stream entry — and they have to
 * agree about what a failure looks like. Copying eight lines is how the two
 * diverge: one grows a stack, the other keeps truncating, and the operator
 * reading both at 3am gets two different renderings of the same `TypeError`.
 *
 * The truncation is not cosmetic. Both call sites write this on *every* failed
 * attempt, and a dependency that stringifies a response body into its message
 * would otherwise put a megabyte into a column the relay reads on every claim,
 * or into a Redis entry that then counts against the stream's memory bound.
 *
 * The stack is deliberately not included: it describes the retry loop, which is
 * the same three frames every time, rather than the failure.
 */

/** How much of a failure's text is kept. */
export const MAX_LAST_ERROR_LENGTH = 1_000;

export function describeFailure(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Non-error thrown: ${String(error)}`;

  return text.length > MAX_LAST_ERROR_LENGTH
    ? `${text.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`
    : text;
}
