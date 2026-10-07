/**
 * Proactive content negotiation for `Accept` (RFC 9110 §12.5.1).
 *
 * Built red→green→refactor; see `docs/tdd-kata.md`.
 */

/**
 * The server's choice among `offered`, or `null` when nothing offered is
 * acceptable to the client.
 *
 * `offered` is in the server's own preference order, which is what breaks a tie
 * between two equally-weighted offers.
 */
export function selectMediaType(
  header: string | null | undefined,
  offered: readonly string[],
): string | null {
  // RFC 9110 §12.5.1: a request with no `Accept` accepts anything, so the
  // server's first preference wins. `null` is the header-absent case too —
  // `req.headers['accept']` is `undefined`, but a caller reading from a map or
  // a database may hold `null`.
  if (header === null || header === undefined) {
    return offered[0] ?? null;
  }

  const wanted = header.trim().toLowerCase();

  for (const offer of offered) {
    if (offer.toLowerCase() === wanted) return offer;
  }

  return null;
}
