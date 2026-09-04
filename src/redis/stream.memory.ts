import type {
  AppendOptions,
  ClaimOptions,
  CreateGroupOptions,
  PendingEntry,
  ReadGroupOptions,
  StreamCommands,
  StreamConnections,
  StreamEntry,
} from '@/redis/stream.types';

/**
 * `StreamCommands` in memory: consumer-group semantics without a server.
 *
 * ## What it is for, and what it is not
 *
 * The worker's interesting behaviours — a handler that throws leaves an entry
 * unacknowledged, the delivery ceiling parks instead of retrying, a stop lands
 * without abandoning work — are properties of the *loop*. Asserting them
 * against a real server means sleeping past a real idle floor for every case,
 * which turns a suite into a minute of waiting and makes the ceiling test
 * (five deliveries, each after an idle timeout) impractical to write at all.
 * Here the clock is a parameter, so those cases run in microseconds and
 * deterministically.
 *
 * It is emphatically **not** evidence about Redis. Everything it does is what
 * its author believed Redis does, so a claim like "XCLAIM refuses an entry
 * below the idle floor" proven here proves nothing. Those live in
 * `redis.integration.test.ts` against a real server, and the same worker
 * scenario is run against both — which is what keeps this file honest.
 *
 * ## Where it is deliberately simpler
 *
 * `MAXLEN` trims exactly rather than approximately: `~` exists so a real server
 * can drop whole radix-tree nodes, and a fake has no nodes. Exact trimming is
 * the stricter of the two — it evicts at least as much — so a test that wants
 * to reproduce an entry being trimmed while pending gets a deterministic
 * version of the case rather than one that depends on node boundaries.
 *
 * Ids are `<ms>-<seq>` from the injected clock, which makes them ordered and
 * comparable exactly as the real ones are.
 */

interface StoredEntry {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

interface PendingRecord {
  consumer: string;
  /** Clock reading of the last delivery or claim. Idle time is measured from it. */
  deliveredAt: number;
  deliveryCount: number;
}

interface Group {
  /**
   * The id of the last entry handed out; `''` means "nothing yet".
   *
   * An id and not an index into `entries`, because trimming shifts indices: an
   * index cursor silently skips every entry that moved down when the cap
   * evicted the front of the stream, which is the exact scenario the trimming
   * tests set up. Redis keeps an id here for the same reason.
   */
  cursor: string;
  readonly pending: Map<string, PendingRecord>;
  readonly consumers: Set<string>;
}

export interface MemoryStreamOptions {
  /** Injected so a test can move past an idle floor without waiting for one. */
  readonly now?: () => number;
  /**
   * Whether a read with nothing to return waits out its `blockMs`.
   *
   * On by default because that wait is what keeps a worker's loop from spinning
   * — a fake that returns instantly turns `while (!stopping) await tick()` into
   * a busy loop that starves the test's own timers. Tests pass a `blockMs` of a
   * few milliseconds, so the wait is real but negligible.
   */
  readonly honourBlock?: boolean;
}

export class MemoryStreamCommands implements StreamCommands {
  private readonly streams = new Map<string, StoredEntry[]>();
  private readonly groups = new Map<string, Map<string, Group>>();
  private readonly now: () => number;
  private readonly honourBlock: boolean;
  private sequence = 0;

  constructor(options: MemoryStreamOptions = {}) {
    this.now = options.now ?? Date.now;
    this.honourBlock = options.honourBlock ?? true;
  }

  /** Entries currently on a stream, for assertions about trimming. */
  entries(key: string): readonly StreamEntry[] {
    return [...(this.streams.get(key) ?? [])];
  }

  /** The group's pending list, for assertions about acknowledgement. */
  pending(key: string, group: string): readonly PendingEntry[] {
    const record = this.groups.get(key)?.get(group);
    if (record === undefined) return [];

    return [...record.pending.entries()].map(([id, entry]) => ({
      id,
      consumer: entry.consumer,
      idleMs: this.now() - entry.deliveredAt,
      deliveryCount: entry.deliveryCount,
    }));
  }

  /** Consumer names the group knows, for assertions about retirement. */
  consumers(key: string, group: string): readonly string[] {
    return [...(this.groups.get(key)?.get(group)?.consumers ?? [])];
  }

  /**
   * Hands an entry to a consumer without going through `readGroup`, so a test
   * can set up "another replica took this and died" without running a second
   * worker.
   */
  deliverTo(key: string, group: string, consumer: string, count: number): readonly StreamEntry[] {
    return this.readGroupSync({ key, group, consumer, count, blockMs: 0 });
  }

  createGroup(key: string, group: string, options: CreateGroupOptions = {}): Promise<'created' | 'exists'> {
    const { from = '$', mkstream = true } = options;

    if (!this.streams.has(key)) {
      if (!mkstream) return Promise.reject(new Error(`NOGROUP No such key '${key}'`));
      this.streams.set(key, []);
    }

    const byGroup = this.groups.get(key) ?? new Map<string, Group>();
    this.groups.set(key, byGroup);

    if (byGroup.has(group)) return Promise.resolve('exists');

    const existing = this.streams.get(key) ?? [];
    byGroup.set(group, {
      // `$` starts after everything already there; `0` before all of it.
      cursor: from === '$' ? (existing[existing.length - 1]?.id ?? '') : '',
      pending: new Map(),
      consumers: new Set(),
    });
    return Promise.resolve('created');
  }

  append(
    key: string,
    fields: Readonly<Record<string, string>>,
    options: AppendOptions = {},
  ): Promise<string> {
    const entries = this.streams.get(key) ?? [];
    this.streams.set(key, entries);

    this.sequence += 1;
    const id = `${this.now()}-${this.sequence}`;
    entries.push({ id, fields: { ...fields } });

    const { maxLen } = options;
    if (maxLen !== undefined && entries.length > maxLen) {
      // Evicted entries may still be referenced by a pending list. The
      // references are left dangling on purpose — that is what a real server
      // does, and `claim` below is where they are cleaned up, which is the
      // behaviour that makes trimming a source of silent work loss.
      entries.splice(0, entries.length - maxLen);
    }

    return Promise.resolve(id);
  }

  private requireGroup(key: string, group: string, command: string): Group {
    const record = this.groups.get(key)?.get(group);
    if (record === undefined) {
      throw new Error(`NOGROUP No such key '${key}' or consumer group '${group}' in ${command}`);
    }
    return record;
  }

  private readGroupSync(options: ReadGroupOptions): readonly StreamEntry[] {
    const { key, group, consumer, count } = options;
    const record = this.requireGroup(key, group, 'XREADGROUP');
    record.consumers.add(consumer);

    const entries = this.streams.get(key) ?? [];
    const delivered: StreamEntry[] = [];

    for (const entry of entries) {
      if (delivered.length >= count) break;
      if (record.cursor !== '' && compareEntryIds(entry.id, record.cursor) <= 0) continue;

      record.cursor = entry.id;
      record.pending.set(entry.id, {
        consumer,
        deliveredAt: this.now(),
        deliveryCount: 1,
      });
      delivered.push({ id: entry.id, fields: entry.fields });
    }

    return delivered;
  }

  async readGroup(options: ReadGroupOptions): Promise<readonly StreamEntry[]> {
    const delivered = this.readGroupSync(options);

    if (delivered.length === 0) {
      if (this.honourBlock && options.blockMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.blockMs));
        // Not re-read after the wait: a real server would return whatever
        // arrived during the block, and a test that needs that calls the loop
        // again. Re-reading here would make the fake's timing, rather than the
        // test's, decide which tick an entry lands in.
      } else {
        // Even with the block turned off, an empty read yields to the event
        // loop. A read that resolves on the microtask queue alone makes
        // `while (!stopping) await tick()` a loop no timer can interrupt: the
        // suite's own `setTimeout` never fires and the process hangs with no
        // failing assertion to point at.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return delivered;
  }

  ack(key: string, group: string, ids: readonly string[]): Promise<number> {
    const record = this.requireGroup(key, group, 'XACK');
    let removed = 0;
    for (const id of ids) {
      if (record.pending.delete(id)) removed += 1;
    }
    return Promise.resolve(removed);
  }

  pendingEntries(options: {
    readonly key: string;
    readonly group: string;
    readonly minIdleMs: number;
    readonly count: number;
    readonly startExclusiveOf?: string;
  }): Promise<readonly PendingEntry[]> {
    const { key, group, minIdleMs, count, startExclusiveOf } = options;
    const record = this.requireGroup(key, group, 'XPENDING');
    const now = this.now();

    const matching = [...record.pending.entries()]
      .filter(([id, entry]) => {
        if (now - entry.deliveredAt < minIdleMs) return false;
        return startExclusiveOf === undefined || id > startExclusiveOf;
      })
      .sort(([a], [b]) => compareEntryIds(a, b))
      .slice(0, count)
      .map(([id, entry]) => ({
        id,
        consumer: entry.consumer,
        idleMs: now - entry.deliveredAt,
        deliveryCount: entry.deliveryCount,
      }));

    return Promise.resolve(matching);
  }

  claim(options: ClaimOptions): Promise<readonly StreamEntry[]> {
    const { key, group, consumer, minIdleMs, ids } = options;
    const record = this.requireGroup(key, group, 'XCLAIM');
    record.consumers.add(consumer);

    const now = this.now();
    const entries = this.streams.get(key) ?? [];
    const claimed: StreamEntry[] = [];

    for (const id of ids) {
      const held = record.pending.get(id);
      if (held === undefined) continue;

      // The idle floor is checked here as well as in `pendingEntries`, and it
      // is what makes two workers reclaiming at the same instant divide the
      // entries instead of duplicating them: whichever claims first resets the
      // idle clock, and the other's claim then fails this test.
      if (now - held.deliveredAt < minIdleMs) continue;

      const entry = entries.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        // The entry was trimmed out from under the pending list. A real server
        // drops the dangling reference rather than returning it; so does this.
        record.pending.delete(id);
        continue;
      }

      held.consumer = consumer;
      held.deliveredAt = now;
      held.deliveryCount += 1;
      claimed.push({ id: entry.id, fields: entry.fields });
    }

    return Promise.resolve(claimed);
  }

  consumerPendingCount(key: string, group: string, consumer: string): Promise<number> {
    const record = this.groups.get(key)?.get(group);
    if (record === undefined) return Promise.resolve(0);

    let count = 0;
    for (const entry of record.pending.values()) {
      if (entry.consumer === consumer) count += 1;
    }
    return Promise.resolve(count);
  }

  deleteConsumer(key: string, group: string, consumer: string): Promise<number> {
    const record = this.groups.get(key)?.get(group);
    if (record === undefined) return Promise.resolve(0);

    let destroyed = 0;
    for (const [id, entry] of record.pending) {
      if (entry.consumer === consumer) {
        record.pending.delete(id);
        destroyed += 1;
      }
    }
    record.consumers.delete(consumer);
    return Promise.resolve(destroyed);
  }
}

/**
 * Ids compare by their two numeric halves, not as strings.
 *
 * `"1712-9" < "1712-10"` is false lexicographically and true in a stream, and
 * the difference shows up exactly once a consumer has handled ten entries in
 * the same millisecond — which is a normal burst, not an edge case.
 */
function compareEntryIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  return Number(aMs) - Number(bMs) || Number(aSeq) - Number(bSeq);
}

/**
 * Both connections backed by one in-memory store.
 *
 * One store and not two, because the split exists to stop a blocking read from
 * delaying an acknowledgement on the same socket — a property of connections,
 * not of data. Two stores would mean a consumer that read from one instance and
 * acknowledged to another, which is a bug the type system exists to prevent
 * rather than a configuration to model.
 */
export function memoryStreamConnections(options: MemoryStreamOptions = {}): StreamConnections & {
  readonly store: MemoryStreamCommands;
} {
  const store = new MemoryStreamCommands(options);
  return { blocking: store, commands: store, store };
}
