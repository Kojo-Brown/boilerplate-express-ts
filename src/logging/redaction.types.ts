/**
 * The markers a redacted value is replaced with.
 *
 * They are distinct rather than one `[redacted]` for everything because the
 * person reading the log is usually trying to decide whether the line is worth
 * escalating, and "a bearer token appeared in an error message" and "a customer
 * typed their email into the search box" are different incidents. The marker is
 * the only part of the finding that survives redaction, so it has to carry that
 * much.
 *
 * Every marker is bracketed, and no detector below matches a bracket. That is
 * what keeps the pass idempotent: redacting an already-redacted record produces
 * the same record rather than a marker nested inside another marker.
 */
export const REDACTED = '[redacted]';
export const REDACTED_EMAIL = '[redacted:email]';
export const REDACTED_JWT = '[redacted:jwt]';
export const REDACTED_CARD = '[redacted:card]';
export const REDACTED_IBAN = '[redacted:iban]';

/** A structure nested deeper than `maxDepth`. */
export const TRUNCATED_DEPTH = '[truncated:depth]';
/** A node that is its own ancestor. */
export const CIRCULAR = '[circular]';
/** A value the walk refuses to descend into — see `describeOpaque`. */
export const OPAQUE = '[opaque]';

/**
 * What `redact` does when it cannot finish.
 *
 * A redactor that throws is worse than no redactor: it turns a log statement —
 * the thing a handler reaches for *because* something has already gone wrong —
 * into a second failure on top of the first, and it does so at exactly the
 * moment the original error stops being recoverable. So the whole walk is
 * wrapped once and this is the fallback, which is deliberately not the input.
 */
export const UNSERIALISABLE = '[unserialisable]';

/**
 * The knobs, all of them bounds rather than behaviour switches.
 *
 * There is no `enabled: false`. A redactor that can be turned off is one
 * environment variable away from a production log full of bearer tokens, and
 * the switch is always set in a hurry by somebody debugging at 3am who does not
 * put it back. The escape hatch this module offers instead is `extraKeys`,
 * which only ever redacts *more*.
 */
export interface RedactionPolicy {
  /**
   * Deployment-specific key names to treat as sensitive, on top of the built-in
   * set. Matched by the same word rules — see `isSensitiveKey`.
   */
  readonly extraKeys: readonly string[];
  /**
   * How deep the walk goes before it stops and writes `TRUNCATED_DEPTH`.
   *
   * This is a redaction control and not only a size control: the cost of a deep
   * structure is not that the line is long, it is that nobody reads past the
   * first screen, so a secret at depth 40 is unreviewed either way.
   */
  readonly maxDepth: number;
  /** How many array elements survive; the rest become one summary string. */
  readonly maxArrayLength: number;
  /** How many characters of any one string survive. */
  readonly maxStringLength: number;
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  extraKeys: [],
  maxDepth: 8,
  maxArrayLength: 100,
  maxStringLength: 2_000,
};

/** Takes any value a call site wants logged, returns one safe to serialise. */
export type Redactor = (value: unknown) => unknown;
