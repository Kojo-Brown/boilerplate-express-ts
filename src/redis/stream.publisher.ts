import { encodeEnvelope } from '@/redis/stream.envelope';
import type { StreamEventEnvelope } from '@/redis/stream.envelope';
import type { StreamCommands } from '@/redis/stream.types';

export interface StreamPublisherOptions {
  readonly commands: StreamCommands;
  readonly key: string;
  /**
   * The stream's length cap. See `AppendOptions.maxLen` for why this is not
   * optional in practice — acknowledging an entry does not remove it, so an
   * untrimmed stream grows for as long as the service runs.
   */
  readonly maxLen: number;
  /** Exact trimming instead of the default `MAXLEN ~`. Costs an `XADD` a node split. */
  readonly exactTrim?: boolean;
}

export interface StreamPublisher {
  /** Appends one event. Resolves with the id Redis assigned the entry. */
  publish(envelope: StreamEventEnvelope): Promise<string>;
}

/**
 * The producing half: an envelope becomes an entry on the stream.
 *
 * It is deliberately thin — one `XADD` with the trim policy attached — and the
 * thinness is the design. A producer that batched, or retried, or held a buffer
 * would be re-implementing the durability the caller already has: everything
 * published through here comes from a committed outbox row, and an `XADD` that
 * fails leaves that row unmarked, so the relay retries it with its own backoff
 * ladder. A retry here would be a second, uncoordinated ladder on top of that
 * one, and a buffer here would be state that a crash loses — which is the
 * property the outbox exists to remove.
 *
 * ## Why the cap lives on the producer
 *
 * Trimming is `XADD`'s job rather than a periodic `XTRIM` because the bound
 * should be enforced by the thing that grows the stream. A sweeper is a second
 * moving part that can be paused, misconfigured, or lag behind a burst — and it
 * is precisely during a burst that the bound matters.
 *
 * The number is a safety margin over the worst tolerable backlog, not a queue
 * depth. Entries evicted while still pending are *gone*: the consumer group's
 * pending list keeps referencing them, and the reference resolves to nothing —
 * Redis quietly drops it on the next claim. That is silent work loss, and the
 * only defence is a cap high enough that reaching it means an outage somebody
 * is already awake for.
 */
export function createStreamPublisher(options: StreamPublisherOptions): StreamPublisher {
  const { commands, key, maxLen, exactTrim = false } = options;

  if (!Number.isInteger(maxLen) || maxLen <= 0) {
    throw new RangeError(
      `createStreamPublisher: maxLen must be a positive integer, received ${String(maxLen)}`,
    );
  }

  return {
    async publish(envelope: StreamEventEnvelope): Promise<string> {
      return commands.append(key, encodeEnvelope(envelope), {
        maxLen,
        approximate: !exactTrim,
      });
    },
  };
}
