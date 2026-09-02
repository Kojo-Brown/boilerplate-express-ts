/**
 * Close codes, and the one rule about them that bites.
 *
 * A WebSocket close frame carries a 16-bit code and a reason, and the reason is
 * *not* free-form: the whole control frame payload is capped at 125 bytes by
 * RFC 6455 §5.5, two of which are the code, leaving 123 bytes for the reason.
 * `ws` enforces this by throwing from `close()` — so a reason built by
 * interpolating something a client sent turns a policy close into an uncaught
 * exception on the server. `closeWithReason` is the only close path in this
 * module for that reason; see `truncateCloseReason`.
 */

/**
 * The codes this service sends.
 *
 * 1000–2999 are defined by the protocol; 4000–4999 are reserved for the
 * application and are the only ones a client can rely on us to mean something
 * specific by. The split matters to a client's reconnect logic: a `1001` on a
 * rolling restart should be retried immediately, a `4008` should not be retried
 * at the same send rate, and a `4001` needs a new token before reconnecting at
 * all. A client that treats every close the same reconnects into the same
 * refusal forever.
 */
export const WS_CLOSE = {
  /** Clean shutdown of a conversation that finished. */
  NORMAL: 1000,
  /** The process is going down. Retry, after a backoff. */
  GOING_AWAY: 1001,
  /**
   * Protocol-level policy violation. Sent for a frame we will not process at
   * all, as opposed to the application-level refusals below.
   */
  POLICY_VIOLATION: 1008,
  /** A frame above `maxPayloadBytes`. `ws` sends this one itself. */
  MESSAGE_TOO_BIG: 1009,
  /** A bug on this side. Never carries detail — see `closeWithReason`. */
  INTERNAL_ERROR: 1011,

  /**
   * The access token presented at the handshake has expired.
   *
   * Distinct from every other close because it is the one a client can fix, and
   * the fix is not "reconnect": it is "refresh the token, *then* reconnect".
   * A client that retries with the same credential gets refused at the
   * handshake, which is a slower loop with the same outcome.
   */
  TOKEN_EXPIRED: 4001,

  /** The peer stopped answering pings. See `WsConnectionOptions.heartbeatIntervalMs`. */
  UNRESPONSIVE: 4002,

  /**
   * The connection exceeded its inbound budget. See `WsConnectionOptions.rateLimit`.
   *
   * 4008 rather than 1008 deliberately: the frame was well-formed and would
   * have been processed a second later. It is the WebSocket analogue of HTTP
   * 429, and a client should slow down rather than treat its last message as
   * malformed and rebuild it.
   */
  RATE_LIMITED: 4008,

  /**
   * The peer stopped reading and its outbound buffer passed the ceiling.
   * See `WsConnectionOptions.maxBufferedBytes`.
   */
  SLOW_CONSUMER: 4009,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

/** The reason budget from RFC 6455 §5.5: 125 bytes of control payload, less the 2-byte code. */
export const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Cuts a reason to what will fit in a close frame, without splitting a
 * character in half.
 *
 * The budget is in *bytes* and JavaScript strings are counted in UTF-16 code
 * units, so `reason.slice(123)` is both wrong (it can still exceed the budget —
 * one emoji is four bytes) and dangerous (it can cut a multi-byte sequence
 * mid-character, and the replacement character it decodes to on the other side
 * is a debugging session nobody enjoys). Encoding, cutting on a byte boundary
 * and decoding with a fatal-free `TextDecoder` drops the partial character
 * rather than mangling it: `TextDecoder` without `fatal` yields U+FFFD for the
 * truncated tail, which is stripped.
 */
export function truncateCloseReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.length <= MAX_CLOSE_REASON_BYTES) return reason;

  const decoded = new TextDecoder().decode(bytes.subarray(0, MAX_CLOSE_REASON_BYTES));
  // The final code unit is U+FFFD exactly when the cut landed inside a
  // multi-byte sequence; a legitimate U+FFFD in the input would already have
  // been three bytes and survives whole, so this only ever removes a fragment.
  return decoded.endsWith('�') ? decoded.slice(0, -1) : decoded;
}
