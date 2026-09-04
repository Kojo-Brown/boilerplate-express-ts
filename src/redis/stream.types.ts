/**
 * The Redis surface this subsystem depends on, in this application's
 * vocabulary rather than in RESP's.
 *
 * It is a port, and a deliberately small one: seven operations, each returning
 * a decoded value. Two things follow from that, and both are the reason it
 * exists.
 *
 * **The reply parsing happens once.** Redis stream replies are nested arrays of
 * bulk strings — `XPENDING` in its extended form answers with a four-element
 * tuple per entry and `XREADGROUP` with a stream-keyed array of `[id, [field,
 * value, …]]` pairs — and the shapes differ between server versions
 * (`XAUTOCLAIM` gained a third reply element in 7.0). A worker that reads those
 * arrays inline would grow an index into a nested `unknown` at every call site,
 * each of which is a cast, and none of which would be checked. Here there is
 * exactly one adapter, its parsing is covered by tests that run against a real
 * server, and everything above it is typed.
 *
 * **The worker is testable without a broker.** The loop's interesting
 * behaviours — what happens when a handler throws, when the delivery ceiling is
 * hit, when a stop lands mid-batch — are properties of the loop and not of
 * Redis, and a fake implementing this interface exercises them in milliseconds
 * and deterministically. The behaviours that *are* properties of Redis (does
 * `XCLAIM` really refuse an entry whose idle time is below the floor, does it
 * really drop a pending reference to a trimmed entry) are covered separately,
 * against a real server, because a fake asserting them would only be asserting
 * what its author believed.
 */

/** One entry as it comes off a stream: the id Redis assigned, and its fields. */
export interface StreamEntry {
  /** `<millisecondsTime>-<sequence>`. Monotonic per stream, and the PEL's key. */
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * One row of the pending entries list — the group's record of what has been
 * delivered and not yet acknowledged.
 *
 * This is the structure claim-on-stall is built out of, and `deliveryCount` is
 * the field that makes it safe. Without it a stalled entry is reclaimed
 * forever: a message that kills its handler is idle again a minute later, gets
 * claimed, kills the next consumer, and the group spends the rest of the
 * deployment redelivering one poisoned entry. With it the worker can tell a
 * consumer that died holding good work from work that kills consumers.
 */
export interface PendingEntry {
  readonly id: string;
  /** The consumer currently holding it. May be this one, after a restart. */
  readonly consumer: string;
  /** Milliseconds since it was last delivered or claimed. */
  readonly idleMs: number;
  /** Deliveries so far, counting the first. `XCLAIM` increments it. */
  readonly deliveryCount: number;
}

export interface CreateGroupOptions {
  /**
   * Where a *newly created* group starts. `$` is "entries added from now on";
   * `0` is "everything still in the stream".
   *
   * `$` is the default and the safe one. `0` on a stream that has been running
   * for a week hands the new group a week of history to process at once, which
   * for a consumer with side effects is not a backfill but an incident. It is
   * ignored entirely when the group already exists — a group's cursor is set
   * once, at creation, and no argument here moves it.
   */
  readonly from?: '$' | '0';
  /**
   * Create the stream key if it does not exist yet.
   *
   * On by default, because the alternative is a boot ordering rule: without it
   * a consumer that starts before the first producer has written anything gets
   * `NOGROUP` and cannot create the group, so the group's existence would
   * depend on which container came up first.
   */
  readonly mkstream?: boolean;
}

export interface AppendOptions {
  /**
   * Cap the stream at approximately this many entries, evicting the oldest.
   *
   * Not optional in practice, and the reason surprises people: acknowledging an
   * entry does **not** remove it from the stream. `XACK` clears the pending
   * entry, and the entry itself stays where it is, forever. A stream consumed
   * perfectly by a healthy group therefore grows without bound until the
   * instance runs out of memory — the failure looks like a Redis problem and is
   * a producer that never trimmed.
   *
   * The cap is a *safety margin over the backlog*, not a queue depth: entries
   * evicted while still pending are lost, and the consumer learns about it only
   * as a pending reference to an entry that no longer exists. Size it so that
   * an outage long enough to reach the cap is an outage someone is already
   * awake for.
   */
  readonly maxLen?: number;
  /**
   * Trim at a macro-node boundary (`MAXLEN ~ n`) rather than exactly.
   *
   * On by default. Exact trimming has to split the radix-tree node containing
   * the boundary, which makes every `XADD` pay for the eviction; approximate
   * trimming drops whole nodes and is what the option exists for. The cost is
   * that the stream may sit somewhat above `maxLen`, which does not matter for
   * a bound whose job is to be far above the working set.
   */
  readonly approximate?: boolean;
}

export interface ReadGroupOptions {
  readonly key: string;
  readonly group: string;
  readonly consumer: string;
  /** Entries per read. */
  readonly count: number;
  /**
   * How long the server holds the read open when the stream is empty.
   *
   * This is what makes the loop a subscription rather than a poll, and it is
   * also the floor on how long a graceful shutdown takes: the command is
   * already in flight when the stop arrives, and nothing can be sent on that
   * connection until it returns. Hence the dedicated connection — see
   * `StreamConnections`.
   */
  readonly blockMs: number;
}

export interface ClaimOptions {
  readonly key: string;
  readonly group: string;
  /** The consumer that will own the entries after the claim. */
  readonly consumer: string;
  /**
   * Entries idle for less than this are left alone.
   *
   * Re-stated on the claim as well as on the `XPENDING` that selected the ids,
   * and that repetition is the point: between the two calls another consumer
   * may have claimed the same entry, resetting its idle time. Passing the floor
   * again makes the claim itself refuse — atomically, server-side — so two
   * workers reclaiming at the same instant cannot both take the same entry.
   */
  readonly minIdleMs: number;
  readonly ids: readonly string[];
}

/**
 * The commands the stream subsystem issues, decoded.
 *
 * Every method is one round trip. There is no transaction and no pipeline: the
 * consumer's correctness rests on the pending entries list rather than on
 * atomicity across commands, and the one place where a race would matter — two
 * workers claiming the same stalled entry — is settled by `minIdleMs` inside
 * `XCLAIM` rather than by a lock.
 */
export interface StreamCommands {
  /**
   * `XGROUP CREATE`, made idempotent. Returns which of the two happened, because
   * "this replica created the group" is worth logging once and "it was already
   * there" is the steady state.
   */
  createGroup(key: string, group: string, options?: CreateGroupOptions): Promise<'created' | 'exists'>;

  /** `XADD`. Returns the id the server assigned. */
  append(key: string, fields: Readonly<Record<string, string>>, options?: AppendOptions): Promise<string>;

  /**
   * `XREADGROUP … STREAMS key >`, blocking.
   *
   * `>` is the only id this port accepts, and the omission is deliberate.
   * Passing an explicit id to `XREADGROUP` does not read the stream at all: it
   * reads *this consumer's own* pending list, which is a different operation
   * that recovers nothing from a consumer that died — the case people reach for
   * it to solve. Recovering another consumer's work is `pendingEntries` +
   * `claim`, and keeping the history read out of the port stops the two from
   * being confused.
   */
  readGroup(options: ReadGroupOptions): Promise<readonly StreamEntry[]>;

  /** `XACK`. Returns how many of the ids were actually pending. */
  ack(key: string, group: string, ids: readonly string[]): Promise<number>;

  /**
   * `XPENDING … IDLE`, the extended form.
   *
   * The summary form (`XPENDING key group`) is not enough: it gives a count and
   * a per-consumer tally, and the worker needs per-entry idle times and
   * delivery counts to decide what to claim and what to park.
   */
  pendingEntries(options: {
    readonly key: string;
    readonly group: string;
    readonly minIdleMs: number;
    readonly count: number;
    /** Exclusive lower bound for paging, e.g. `(1712-0`. Defaults to `-`. */
    readonly startExclusiveOf?: string;
  }): Promise<readonly PendingEntry[]>;

  /**
   * `XCLAIM`, returning the entries now owned by `consumer`.
   *
   * Fewer entries than ids is normal and carries information: an id may have
   * been claimed by someone else in the interim (idle time reset, refused), or
   * the entry may have been trimmed out of the stream while still pending — in
   * which case Redis drops the dangling pending reference and returns nothing
   * for it. Both are handled by not assuming a one-to-one mapping.
   */
  claim(options: ClaimOptions): Promise<readonly StreamEntry[]>;

  /**
   * How many entries this consumer still holds. Used before retiring it.
   *
   * `0` when the group does not know the consumer, which is also what a group
   * that does not exist yet reports — the caller is shutting down and has
   * nothing to do about the difference.
   */
  consumerPendingCount(key: string, group: string, consumer: string): Promise<number>;

  /**
   * `XGROUP DELCONSUMER`. Returns the number of pending entries **destroyed**
   * with it.
   *
   * A non-zero return is data loss: deleting a consumer does not hand its
   * pending entries to anybody, it removes them from the list, and the work
   * they represent is never redelivered. That is why the worker checks
   * `consumerPendingCount` first and refuses to retire a consumer that is still
   * holding anything.
   */
  deleteConsumer(key: string, group: string, consumer: string): Promise<number>;
}

/**
 * The two connections a consumer needs, and why it is two.
 *
 * A blocking `XREADGROUP` occupies its connection for the whole block: the
 * client cannot send anything else on it, so an `XACK` issued while a read is
 * blocked queues behind it and lands up to `blockMs` late — and a graceful
 * shutdown that wants to retire a consumer cannot get a command through at all.
 * Redis clients do not multiplex, so the answer is a second connection.
 *
 * Splitting them at the type level rather than by convention means the worker
 * cannot accidentally be handed one connection twice, which fails as a latency
 * mystery rather than as an error.
 */
export interface StreamConnections {
  /** Used only for the blocking read. */
  readonly blocking: StreamCommands;
  /** Everything else: group creation, acks, pending scans, claims. */
  readonly commands: StreamCommands;
}
