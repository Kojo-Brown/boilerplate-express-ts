/**
 * Proactive content negotiation for `Accept` (RFC 9110 §12.5.1).
 *
 * Stub: the kata's first red step. See `docs/tdd-kata.md`.
 */

/** The server's choice among `offered`, or `null` when nothing offered is acceptable. */
export function selectMediaType(
  _header: string | null | undefined,
  _offered: readonly string[],
): string | null {
  throw new Error('not implemented');
}
