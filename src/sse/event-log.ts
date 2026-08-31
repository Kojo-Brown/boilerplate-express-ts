import { randomBytes } from 'node:crypto';

/**
 * The bounded history a reconnecting client resumes from.
 *
 * `Last-Event-ID` is the entire resume protocol: the client stores the `id` of
 * the last frame it dispatched and hands it back on the next connection, and
 * the server is expected to continue from there. Nothing in the format says how
 * — the ids are opaque strings and the retention is the server's problem — so
 * this module is where "continue from there" is given a definition, including
 * the two cases where it honestly cannot be honoured.
 */

/** One event, as it will go on the wire. `data` is already serialised. */
export interface StreamMessage {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

/**
 * Why a cursor could not be resumed from.
 *
 * - `expired` — the cursor is real and too old; the events after it have been
 *   evicted from a buffer that is deliberately finite.
 * - `unknown-stream` — the cursor names a different run of this process (see
 *   `streamId`). The sequence numbers exist in this run too and mean something
 *   entirely different.
 * - `malformed` — the cursor is not a shape this server ever issued.
 */
export type ResumeResetReason = 'expired' | 'unknown-stream' | 'malformed';

/**
 * What a connection should do with the cursor it arrived with.
 *
 * `live` and `replay` are both "your cursor was honoured". `reset` is the one a
 * client has to act on, and the reason it is a value here rather than an error
 * is that it is not a failure of the request: the connection is fine, and the
 * only thing wrong is the assumption that the client's view is still
 * incrementally reachable. Answering 4xx would take away the stream as well.
 */
export type ResumeOutcome =
  | { readonly kind: 'live' }
  | { readonly kind: 'replay'; readonly messages: readonly StreamMessage[] }
  | { readonly kind: 'reset'; readonly reason: ResumeResetReason };

export interface EventLogOptions {
  /**
   * How many past events stay resumable.
   *
   * This is the whole retention policy, and it is a count rather than a
   * duration because what it bounds is memory: `capacity × message size`, held
   * for the lifetime of the process regardless of whether anybody reconnects.
   * The trade it makes is visible in `ResumeResetReason.expired` — a client
   * offline for longer than `capacity` events is told to re-read state rather
   * than being handed a partial history that would look complete.
   */
  readonly capacity: number;

  /** Injected so ids are deterministic under test. */
  readonly streamId?: string;
}

const SEQUENCE_SEPARATOR = ':';

/**
 * A ring of the most recent `capacity` events, plus the id scheme that makes a
 * cursor into them meaningful.
 *
 * **Ids are `<streamId>:<sequence>`, and the prefix is load-bearing.** The
 * sequence alone is the obvious design and is unsafe across a restart: the
 * counter begins at 1 again, so a client reconnecting with `47` after a deploy
 * asks to resume from an event that exists, is not the event it saw, and sits
 * in the middle of the new run's history. The server would replay 48 onwards
 * and both sides would believe the resume worked. With a per-run prefix that
 * cursor cannot match, so the same reconnect gets an honest `reset` — which is
 * exactly the situation a client's re-sync path exists for. It is equally the
 * behaviour to want behind a load balancer, where the log is per-replica and a
 * reconnect lands wherever it lands.
 *
 * The ring is addressed by `sequence % capacity` rather than by a head pointer,
 * which works because sequences are contiguous and monotonic: the slot for a
 * sequence is a function of the sequence, so a read needs no bookkeeping and an
 * append is one store. Whether a slot still holds what a caller is asking for is
 * decided by `oldestSequence`, never by inspecting the slot.
 */
export class SseEventLog {
  readonly #slots: (StreamMessage | undefined)[];
  readonly #capacity: number;
  readonly #streamId: string;
  #latestSequence = 0;

  constructor(options: EventLogOptions) {
    const { capacity } = options;

    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `SseEventLog: capacity must be an integer >= 1, received ${capacity}`,
      );
    }

    this.#capacity = capacity;
    this.#slots = new Array<StreamMessage | undefined>(capacity);
    // 8 bytes rather than a UUID: it is prefixed to every id on the wire and to
    // every id held in the buffer, and 64 bits is far past the point where two
    // runs of one process collide.
    this.#streamId = options.streamId ?? randomBytes(8).toString('hex');

    if (this.#streamId.includes(SEQUENCE_SEPARATOR)) {
      // The parse below splits on the first separator, so a stream id
      // containing one would make `<streamId>:<sequence>` ambiguous.
      throw new RangeError(
        `SseEventLog: streamId may not contain "${SEQUENCE_SEPARATOR}", received "${this.#streamId}"`,
      );
    }
  }

  /** Identifies this run of the log. See the id scheme above. */
  get streamId(): string {
    return this.#streamId;
  }

  /** The id of the most recent event, or `undefined` before the first one. */
  get latestEventId(): string | undefined {
    return this.#latestSequence === 0 ? undefined : this.#idFor(this.#latestSequence);
  }

  /** The oldest sequence still resumable. `1` until the ring has wrapped. */
  get #oldestSequence(): number {
    return Math.max(1, this.#latestSequence - this.#capacity + 1);
  }

  #idFor(sequence: number): string {
    return `${this.#streamId}${SEQUENCE_SEPARATOR}${sequence}`;
  }

  /**
   * Records an event and returns it as it will be sent.
   *
   * The id is minted here rather than by the caller, because the id *is* the
   * position in this log — a caller-supplied one could not be resumed from.
   */
  append(event: string, data: string): StreamMessage {
    const sequence = ++this.#latestSequence;
    const message: StreamMessage = { id: this.#idFor(sequence), event, data };
    this.#slots[sequence % this.#capacity] = message;
    return message;
  }

  /**
   * What to do about a cursor a client arrived with.
   *
   * `undefined` is `live`, not `reset`: a first connection has no cursor and has
   * missed nothing, so telling it to re-sync would make every fresh subscriber
   * do a redundant read.
   *
   * A cursor *ahead* of this log is also `live` rather than an error. It happens
   * legitimately — a replica restarted and a proxy sent the reconnect to a peer
   * — and the client is not missing anything the server could send it. The
   * `unknown-stream` check catches the dangerous form of the same thing first.
   */
  since(lastEventId: string | undefined): ResumeOutcome {
    if (lastEventId === undefined) {
      return { kind: 'live' };
    }

    const separatorAt = lastEventId.indexOf(SEQUENCE_SEPARATOR);
    if (separatorAt === -1) {
      return { kind: 'reset', reason: 'malformed' };
    }

    if (lastEventId.slice(0, separatorAt) !== this.#streamId) {
      return { kind: 'reset', reason: 'unknown-stream' };
    }

    const rawSequence = lastEventId.slice(separatorAt + 1);
    // `Number` rather than `parseInt`: the latter reads a leading number out of
    // any string and would accept `"12abc"` as 12 — turning a corrupted cursor
    // into a plausible position instead of a reset.
    const sequence = /^\d+$/.test(rawSequence) ? Number(rawSequence) : Number.NaN;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      return { kind: 'reset', reason: 'malformed' };
    }

    if (sequence >= this.#latestSequence) {
      return { kind: 'live' };
    }

    // The client holds everything up to and including `sequence` and needs
    // `sequence + 1` onwards, so the boundary is one below the oldest event
    // still in the ring: a cursor pointing at the event *before* the oldest
    // retained one is still fully serviceable.
    if (sequence + 1 < this.#oldestSequence) {
      return { kind: 'reset', reason: 'expired' };
    }

    const messages: StreamMessage[] = [];
    for (let next = sequence + 1; next <= this.#latestSequence; next += 1) {
      const message = this.#slots[next % this.#capacity];
      if (message !== undefined) {
        messages.push(message);
      }
    }

    return { kind: 'replay', messages };
  }
}
