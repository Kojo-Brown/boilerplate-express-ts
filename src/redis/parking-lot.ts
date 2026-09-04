import type { StreamCommands } from '@/redis/stream.types';
import type { ParkedEntry, ParkHandler } from '@/redis/stream.worker';

/**
 * Field names the parking lot adds. Prefixed so an entry's own fields — which
 * are copied across verbatim — cannot collide with them, and so a person
 * reading `XRANGE` output can tell the two apart at a glance.
 */
export const PARK_FIELDS = {
  reason: 'park.reason',
  lastError: 'park.lastError',
  deliveryCount: 'park.deliveryCount',
  sourceStream: 'park.sourceStream',
  sourceEntryId: 'park.sourceEntryId',
  parkedAt: 'park.parkedAt',
} as const;

/** `<key>:parked` — the companion stream a key's parked entries land on. */
export function parkedStreamKey(key: string): string {
  return `${key}:parked`;
}

export interface ParkingLotOptions {
  readonly commands: StreamCommands;
  /** The stream being consumed. The parking lot is derived from it. */
  readonly key: string;
  /**
   * Cap on the parked stream.
   *
   * Much smaller than the source stream's, because entries arrive here at the
   * rate things go wrong rather than at the rate things happen — and because a
   * parked entry that ages out unexamined was never going to be examined. It is
   * still a cap: a producer emitting malformed entries in a loop would
   * otherwise fill the instance with the evidence of it.
   */
  readonly maxLen?: number;
  readonly now?: () => Date;
}

const DEFAULT_PARK_MAX_LEN = 10_000;

/**
 * A `ParkHandler` that writes to a companion stream instead of a log line.
 *
 * The default park handler prints and drops, which is honest but final: the
 * entry is acknowledged, the group forgets it, and what was in it survives only
 * in whatever the log line managed to render. A parked entry is by definition
 * one that failed in a way retrying did not fix, so it is exactly the thing
 * somebody will want to inspect, fix and replay — and none of that is possible
 * from a log.
 *
 * A stream rather than a table for one reason: it is already there. No
 * migration, no second dependency in the consumer's deployment, and `XRANGE`
 * over `<key>:parked` is the same tool the operator is already using on the
 * source. The replay is `XRANGE` and an `XADD` back onto the source with the
 * envelope fields copied over — which works precisely because the original
 * fields are stored untouched beside the park metadata rather than nested
 * inside a JSON blob.
 *
 * This is deliberately *not* the dead-letter queue of the next spec item: there
 * is no retry ladder here, no scheduler and no automatic replay. It is the
 * durable end of the road for an entry the group has given up on.
 */
export function createParkingLot(options: ParkingLotOptions): ParkHandler {
  const { commands, key, maxLen = DEFAULT_PARK_MAX_LEN, now = () => new Date() } = options;
  const target = parkedStreamKey(key);

  return async function parkToStream(parked: ParkedEntry): Promise<void> {
    await commands.append(
      target,
      {
        ...parked.entry.fields,
        [PARK_FIELDS.reason]: parked.reason,
        [PARK_FIELDS.lastError]: parked.lastError,
        [PARK_FIELDS.deliveryCount]: String(parked.deliveryCount),
        [PARK_FIELDS.sourceStream]: key,
        // The source id is kept because the parked entry gets a new one: it is
        // a different entry on a different stream, and without this there is no
        // way back to the pending-list history that explains how it got here.
        [PARK_FIELDS.sourceEntryId]: parked.entry.id,
        [PARK_FIELDS.parkedAt]: now().toISOString(),
      },
      { maxLen, approximate: true },
    );
  };
}
