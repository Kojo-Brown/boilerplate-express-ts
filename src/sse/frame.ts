/**
 * The `text/event-stream` wire format, and nothing else.
 *
 * Strings in, strings out — no `Response`, no timers, no state. That is what
 * makes the table of edge cases in `frame.test.ts` exhaustive rather than
 * representative: every rule the format has is a property of one of these three
 * functions, and none of them needs a socket to exercise.
 *
 * The format looks forgiving and is not. It has no escape sequence at all, so a
 * field value is delimited by the line break that ends it and by nothing else;
 * a newline reaching `id` or `event` does not corrupt a field, it *ends the
 * field and starts another*, which is how a payload becomes a forged event.
 * Every rejection below is that failure, caught where it is still a programming
 * error instead of a client acting on an event the server never sent.
 *
 * Spec references are to WHATWG HTML §9.2, "Server-sent events".
 */

/** CRLF, a bare CR, and a bare LF are all line terminators to the client. */
const LINE_TERMINATOR = /\r\n|[\r\n]/;

/** Global form of the above, for `replace`. Kept separate: `lastIndex` is state. */
const LINE_TERMINATOR_GLOBAL = /\r\n|[\r\n]/g;

/**
 * The maximum length accepted for an event name or id.
 *
 * Not a spec limit — the format has none. It is a bound on what a single
 * connection can be made to hold in the replay log and re-send on every
 * reconnect, and it is far above any name or cursor this service mints.
 */
export const MAX_FIELD_LENGTH = 256;

/** One dispatched event. `data` is the only field a client is guaranteed. */
export interface SseFrame {
  /**
   * Sets the client's cursor, echoed back as `Last-Event-ID` on reconnect.
   *
   * Omitted deliberately for control frames: a frame with no `id` leaves the
   * cursor where it was, which is what a message that is *about* the stream
   * rather than part of it should do. Advancing the cursor past a frame the
   * server would not replay is how a resume silently skips real events.
   */
  readonly id?: string;

  /**
   * Dispatched as this event type instead of `message`.
   *
   * Note the asymmetry with `data`: a client listening with
   * `addEventListener('user.created', …)` receives *nothing* on a frame that
   * omits this, because the default type is `message` and those are different
   * listeners. Omitting it is therefore a decision, not a default.
   */
  readonly event?: string;

  /**
   * The payload. Serialised by the caller — this module never calls
   * `JSON.stringify`, because a frame carrying pre-encoded text is what lets
   * the hub serialise once for every subscriber rather than once per socket.
   */
  readonly data: string;
}

function rejectFieldValue(field: string, value: string): void {
  if (LINE_TERMINATOR.test(value)) {
    throw new RangeError(
      `encodeFrame: "${field}" may not contain a line break — the format has no escape for one, ` +
        'so the value would end the field and the remainder would be parsed as further fields',
    );
  }

  // §9.2.6: a client *ignores* an `id` whose value contains U+0000, which is
  // the worst possible outcome — the frame is delivered, the cursor silently
  // does not move, and the next reconnect replays from an older position while
  // appearing to work. Rejected for `event` too, for symmetry and because
  // nothing legitimate puts a NUL in an event name.
  if (value.includes('\u0000')) {
    throw new RangeError(
      `encodeFrame: "${field}" may not contain U+0000 — a client silently discards the field ` +
        'rather than failing, so the effect is a cursor that never advances',
    );
  }

  if (value.length > MAX_FIELD_LENGTH) {
    throw new RangeError(
      `encodeFrame: "${field}" is ${value.length} characters, above the ${MAX_FIELD_LENGTH} limit`,
    );
  }
}

/**
 * A frame, terminated by the blank line that dispatches it.
 *
 * `data` is *normalised* rather than rejected, and that is not an inconsistency
 * with the fields above. A line break in `id` or `event` changes which fields
 * exist; a line break in `data` is legal and expressible — the value is simply
 * emitted as several `data:` lines, which the client rejoins with `\n`. What it
 * cannot express is *which* terminator was used, since the client's line
 * splitter treats CRLF, CR and LF identically and rejoins with LF regardless.
 * Normalising here makes the string this function is given equal to the string
 * the client will observe, instead of leaving a `\r` that survives the encode
 * and not the decode.
 *
 * A caller needing bytes back exactly as it sent them wants JSON, which escapes
 * the control characters the format cannot carry. Everything published through
 * `SseHub` is JSON for that reason.
 */
export function encodeFrame(frame: SseFrame): string {
  const lines: string[] = [];

  if (frame.id !== undefined) {
    rejectFieldValue('id', frame.id);
    lines.push(`id: ${frame.id}`);
  }

  if (frame.event !== undefined) {
    rejectFieldValue('event', frame.event);
    if (frame.event === '') {
      // `event:` with an empty value resets the type buffer to the empty string,
      // which dispatches as `message` — the same as omitting the field, at the
      // cost of a line. Almost certainly a bug at the call site.
      throw new RangeError('encodeFrame: "event" may not be empty — omit it to dispatch as `message`');
    }
    lines.push(`event: ${frame.event}`);
  }

  // An empty `data` is encoded rather than rejected, and is worth knowing about:
  // §9.2.6 updates the client's last event id and then returns *without*
  // dispatching, because the data buffer is empty. So an empty frame carrying an
  // `id` moves the cursor and fires no listener. It is left legal because that
  // is occasionally what a caller wants — a checkpoint — and rejecting it would
  // make `encodeFrame` disagree with the format for no gain.
  for (const line of frame.data.replace(LINE_TERMINATOR_GLOBAL, '\n').split('\n')) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join('\n')}\n\n`;
}

/**
 * A comment line: bytes on the socket that dispatch nothing.
 *
 * This is the entire mechanism behind the heartbeat. There is no ping frame in
 * the format and no need for one — a comment is ignored by every conforming
 * client, so it can be sent at any time without a client having to know it
 * exists, while still being a write that proves the path from this process to
 * that socket is open and keeps an idle-connection timer in every proxy along
 * the way from firing.
 */
export function encodeComment(text: string): string {
  // A line break here would end the comment and let the remainder be parsed as
  // fields — the same injection as above, from what is usually the most
  // attacker-adjacent string in the file (a reason, a status, a name).
  if (LINE_TERMINATOR.test(text)) {
    throw new RangeError('encodeComment: text may not contain a line break');
  }

  return `: ${text}\n\n`;
}

/**
 * Sets the client's reconnection delay, in milliseconds.
 *
 * Sent once when the stream opens, and it is the only backoff control the
 * server has: `EventSource` reconnects on its own, forever, and a client that
 * has not been told otherwise uses a delay the browser chose. A deployment that
 * drops every connection at once — a rolling restart — gets that delay back as
 * a thundering herd, so the value is configuration rather than a constant.
 *
 * §9.2.6 requires the value be ASCII digits only and ignores the field
 * otherwise, which is the silent failure this rejects.
 */
export function encodeRetry(delayMs: number): string {
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new RangeError(
      `encodeRetry: delay must be a non-negative integer number of milliseconds, received ${delayMs}`,
    );
  }

  return `retry: ${delayMs}\n\n`;
}
