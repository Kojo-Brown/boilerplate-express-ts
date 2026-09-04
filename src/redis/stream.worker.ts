import { fullJitterDelay } from '@/lib/backoff';
import { describeFailure } from '@/lib/describe-error';
import {
  isNoGroupError,
  MalformedStreamEntryError,
  StreamHandlerTimeoutError,
} from '@/redis/redis.errors';
import { decodeEnvelope } from '@/redis/stream.envelope';
import type { StreamEventEnvelope } from '@/redis/stream.envelope';
import type { StreamCommands, StreamConnections, StreamEntry } from '@/redis/stream.types';

/**
 * A consumer-group worker over one Redis stream, with claim-on-stall recovery.
 *
 * ## What a consumer group buys, and what it costs
 *
 * `XREAD` hands every reader every entry, which makes N replicas do the same
 * work N times. A consumer group partitions instead: each entry goes to exactly
 * one consumer, and the group remembers what it handed out in the **pending
 * entries list** (the PEL) until that consumer acknowledges it. The PEL is what
 * makes the whole thing recoverable — a consumer that dies mid-entry leaves the
 * entry in the list, owned by a name that will never come back, where another
 * consumer can find it by how long it has sat idle. That recovery is what
 * `reclaimStalled` below is, and it is the reason a group is worth its
 * bookkeeping over a plain `XREAD`.
 *
 * What it costs is ordering. Entries are dealt out to whichever consumer asked
 * first, a failed entry stays pending while later ones are processed, and a
 * reclaim can run an entry minutes after the entries behind it. There is no
 * per-key ordering guarantee here at all, and a handler that assumes one — "the
 * update always arrives after the create" — is wrong on the first retry rather
 * than on the first outage.
 *
 * ## At-least-once, and where the "at least" comes from
 *
 * An entry is acknowledged **after** its handler resolves. A crash in between
 * leaves the entry pending, it is reclaimed on idle time, and it runs again —
 * so a handler that has already applied half its effects will apply them a
 * second time. Acknowledging first would trade that for lost work, which is not
 * a trade: a duplicate is recoverable by an idempotent handler and a loss is
 * recoverable by nothing.
 *
 * `envelope.id` is stable across every redelivery — it is the producer's id,
 * carried in the entry rather than assigned by Redis — so "have I already done
 * this one" is answerable. `context.deliveryCount` says how many times the
 * group has handed the entry out, which is how a handler can tell a first
 * attempt from a retry.
 *
 * ## Why not `XAUTOCLAIM`
 *
 * `XAUTOCLAIM` does in one round trip what `pendingEntries` + `claim` do in
 * two, and it does not report delivery counts. Without them there is no way to
 * tell a consumer that died holding good work from an entry that *kills*
 * consumers: both are idle, both get claimed, and the poisoned one is claimed
 * again a minute later, forever. A worker built on `XAUTOCLAIM` has no place to
 * put the ceiling that stops that, so this one pays the extra round trip per
 * reclaim — a command every few seconds, against a bug that otherwise runs
 * until someone notices the log.
 */

/** Why an entry was taken out of the retry cycle. */
export type ParkReason =
  /** Its handler failed `maxDeliveries` times. */
  | 'delivery-ceiling'
  /** It is not a valid envelope, so no attempt can succeed. */
  | 'undecodable';

export interface ParkedEntry {
  readonly entry: StreamEntry;
  readonly reason: ParkReason;
  /** The last failure, in `describeFailure`'s one-line form. */
  readonly lastError: string;
  readonly deliveryCount: number;
}

export interface StreamEntryContext {
  /** The Redis entry id, `<ms>-<seq>`. Not the event's id — that is on the envelope. */
  readonly entryId: string;
  /** Deliveries so far, counting this one. `1` on a first delivery. */
  readonly deliveryCount: number;
  /** True when this delivery came from the reclaim path rather than a fresh read. */
  readonly reclaimed: boolean;
}

/**
 * What the worker calls for each entry.
 *
 * **Throwing is how it says "not processed".** A handler that resolves has
 * asserted the work is done, because the worker acknowledges on that promise
 * fulfilling and the entry is then unrecoverable. One that swallows its own
 * failures turns the group into an expensive way to delete messages.
 */
export type StreamHandler = (
  envelope: StreamEventEnvelope,
  context: StreamEntryContext,
) => Promise<void>;

/**
 * Where an entry goes when it has stopped being retryable.
 *
 * It runs *before* the acknowledgement, and a throw from it aborts the park —
 * leaving the entry pending, to be parked again on the next reclaim. That
 * ordering is the whole value of the hook: a parking lot that is itself down
 * must not result in the entry being dropped, which is what acknowledging first
 * would do.
 */
export type ParkHandler = (parked: ParkedEntry) => Promise<void>;

export interface StreamTickOutcome {
  /** Entries delivered fresh by `XREADGROUP`. */
  readonly read: number;
  /** Entries taken from a stalled consumer. */
  readonly reclaimed: number;
  /** Handled and acknowledged. */
  readonly handled: number;
  /** Handler failed; left pending for a later reclaim. */
  readonly failed: number;
  /** Taken out of the cycle and acknowledged. */
  readonly parked: number;
}

const EMPTY_OUTCOME: StreamTickOutcome = { read: 0, reclaimed: 0, handled: 0, failed: 0, parked: 0 };

function addOutcome(a: StreamTickOutcome, b: StreamTickOutcome): StreamTickOutcome {
  return {
    read: a.read + b.read,
    reclaimed: a.reclaimed + b.reclaimed,
    handled: a.handled + b.handled,
    failed: a.failed + b.failed,
    parked: a.parked + b.parked,
  };
}

export interface StreamWorkerOptions {
  readonly connections: StreamConnections;
  readonly key: string;
  readonly group: string;
  /**
   * This consumer's name inside the group.
   *
   * Stable per replica, not per process start. A name containing the pid leaves
   * an orphan consumer in the group on every restart — each one a permanent
   * entry in `XINFO CONSUMERS`, and each one potentially holding entries that
   * now depend entirely on the reclaim path. A pod name or a hostname is right:
   * a restarted replica reclaims its own predecessor's work by idle time and
   * reuses the same slot.
   */
  readonly consumer: string;
  readonly handler: StreamHandler;
  /** Default: logs the entry at `error` level and drops it. */
  readonly onPark?: ParkHandler;
  /** Entries per read. */
  readonly batchSize?: number;
  /**
   * How long a read blocks when the stream is empty.
   *
   * Also the floor on how long a graceful stop takes: the command is in flight
   * when the stop arrives and cannot be interrupted without dropping the
   * connection. Seconds, not minutes.
   */
  readonly blockMs?: number;
  /** Backstop for a handler that does not come back. See `StreamHandlerTimeoutError`. */
  readonly handlerTimeoutMs?: number;
  /**
   * How long an entry must sit unacknowledged before another consumer may take
   * it.
   *
   * The single most dangerous number here. Below the handler timeout it makes a
   * *healthy but slow* consumer's entries claimable, so the work runs twice
   * concurrently — the failure looks like a duplicate-processing bug and is a
   * configuration one. The constructor refuses that arrangement rather than
   * documenting it.
   *
   * Above, it is a straight trade: it is how long recovery waits after a
   * replica dies.
   */
  readonly minIdleMs?: number;
  /**
   * Deliveries before an entry is parked, counting the first.
   *
   * Finite because claim-on-stall has no other stopping condition. An entry
   * whose handler always fails is idle again `minIdleMs` later, forever, and
   * with it a slot in every reclaim batch for the life of the deployment.
   */
  readonly maxDeliveries?: number;
  /** Pending entries examined per reclaim. */
  readonly claimBatchSize?: number;
  /**
   * How often the pending list is scanned.
   *
   * Reclaiming on every tick would issue an `XPENDING` per block expiry, which
   * on an idle stream is a command every `blockMs` forever. The recovery
   * latency is `minIdleMs + reclaimIntervalMs` in the worst case, so this
   * belongs well below `minIdleMs`.
   */
  readonly reclaimIntervalMs?: number;
  /**
   * First pause after a tick that threw; doubles per consecutive failure, with
   * full jitter.
   *
   * Without it the loop is a busy wait during exactly the outage it should be
   * riding out: a read against an unreachable server rejects immediately, the
   * `catch` logs, and the loop comes straight back — a core at 100% and a log
   * line per microsecond, on every replica at once. The jitter matters for the
   * same reason it does in the outbox relay: every consumer failed at the same
   * instant, so an unjittered ladder brings them all back together and the
   * recovering server meets a synchronised spike.
   */
  readonly errorBackoffMs?: number;
  /** Ceiling for a single backoff step, however long the outage lasts. */
  readonly maxErrorBackoffMs?: number;
  /** Called after every tick. Default: logs anything that was not a clean handle. */
  readonly onOutcome?: (outcome: StreamTickOutcome) => void;
  /** Called when a tick throws. Default: logs. Never rethrows. */
  readonly onError?: (error: unknown) => void;
  /** Injected so a test can drive the reclaim cadence without waiting. */
  readonly now?: () => number;
  /** Injected so the error backoff's jitter is reproducible under test. */
  readonly random?: () => number;
}

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_BLOCK_MS = 2_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_IDLE_MS = 30_000;
const DEFAULT_MAX_DELIVERIES = 5;
const DEFAULT_CLAIM_BATCH_SIZE = 16;
const DEFAULT_RECLAIM_INTERVAL_MS = 5_000;
const DEFAULT_ERROR_BACKOFF_MS = 500;
const DEFAULT_MAX_ERROR_BACKOFF_MS = 30_000;

interface ResolvedOptions {
  readonly key: string;
  readonly group: string;
  readonly consumer: string;
  readonly handler: StreamHandler;
  readonly onPark: ParkHandler;
  readonly batchSize: number;
  readonly blockMs: number;
  readonly handlerTimeoutMs: number;
  readonly minIdleMs: number;
  readonly maxDeliveries: number;
  readonly claimBatchSize: number;
  readonly reclaimIntervalMs: number;
  readonly errorBackoffMs: number;
  readonly maxErrorBackoffMs: number;
  readonly onOutcome: (outcome: StreamTickOutcome) => void;
  readonly onError: (error: unknown) => void;
  readonly now: () => number;
  readonly random: () => number;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`createStreamWorker: ${name} must be a positive integer, received ${String(value)}`);
  }
}

function defaultOnPark(parked: ParkedEntry): Promise<void> {
  // Loud, because the default loses the entry. A deployment that cares supplies
  // `onPark` — `createParkingLot` writes it to a companion stream — and this is
  // what makes the absence of one visible rather than silent.
  console.error(
    `[stream worker] parked entry ${parked.entry.id} after ${parked.deliveryCount} ` +
      `delivery(ies) (${parked.reason}): ${parked.lastError}`,
  );
  return Promise.resolve();
}

function defaultOnOutcome(outcome: StreamTickOutcome): void {
  // A tick that read nothing and a tick that handled everything are both the
  // steady state; logging either on every block expiry is how a channel becomes
  // unreadable. A reclaim or a park is a fact about the service.
  if (outcome.reclaimed > 0 || outcome.failed > 0 || outcome.parked > 0) {
    console.warn(
      `[stream worker] ${outcome.handled} handled, ${outcome.reclaimed} reclaimed, ` +
        `${outcome.failed} failed, ${outcome.parked} parked`,
    );
  }
}

function defaultOnError(error: unknown): void {
  console.error('[stream worker] tick failed:', error);
}

function resolveOptions(options: StreamWorkerOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    key: options.key,
    group: options.group,
    consumer: options.consumer,
    handler: options.handler,
    onPark: options.onPark ?? defaultOnPark,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    blockMs: options.blockMs ?? DEFAULT_BLOCK_MS,
    handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    minIdleMs: options.minIdleMs ?? DEFAULT_MIN_IDLE_MS,
    maxDeliveries: options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES,
    claimBatchSize: options.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE,
    reclaimIntervalMs: options.reclaimIntervalMs ?? DEFAULT_RECLAIM_INTERVAL_MS,
    errorBackoffMs: options.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS,
    maxErrorBackoffMs: options.maxErrorBackoffMs ?? DEFAULT_MAX_ERROR_BACKOFF_MS,
    onOutcome: options.onOutcome ?? defaultOnOutcome,
    onError: options.onError ?? defaultOnError,
    now: options.now ?? Date.now,
    random: options.random ?? Math.random,
  };

  if (resolved.key.length === 0) throw new RangeError('createStreamWorker: key must not be empty');
  if (resolved.group.length === 0) throw new RangeError('createStreamWorker: group must not be empty');
  if (resolved.consumer.length === 0) {
    throw new RangeError('createStreamWorker: consumer must not be empty');
  }

  requirePositiveInteger('batchSize', resolved.batchSize);
  requirePositiveInteger('blockMs', resolved.blockMs);
  requirePositiveInteger('handlerTimeoutMs', resolved.handlerTimeoutMs);
  requirePositiveInteger('minIdleMs', resolved.minIdleMs);
  requirePositiveInteger('maxDeliveries', resolved.maxDeliveries);
  requirePositiveInteger('claimBatchSize', resolved.claimBatchSize);
  requirePositiveInteger('reclaimIntervalMs', resolved.reclaimIntervalMs);
  requirePositiveInteger('errorBackoffMs', resolved.errorBackoffMs);
  requirePositiveInteger('maxErrorBackoffMs', resolved.maxErrorBackoffMs);

  // The invariant that keeps claim-on-stall from becoming run-it-twice. An
  // entry's idle clock starts when it is delivered, which is the instant its
  // handler starts, so a handler permitted to run for `handlerTimeoutMs` will
  // routinely leave an entry idle for that long while nothing whatever is
  // wrong. A reclaim floor at or below that reclassifies "slow" as "stalled"
  // and hands the entry to a second consumer while the first is still holding
  // it — two handlers, same entry, concurrently, on a healthy system.
  if (resolved.minIdleMs <= resolved.handlerTimeoutMs) {
    throw new RangeError(
      `createStreamWorker: minIdleMs (${resolved.minIdleMs}) must exceed handlerTimeoutMs ` +
        `(${resolved.handlerTimeoutMs}); otherwise an entry still being processed by a healthy ` +
        `consumer becomes claimable and runs twice concurrently`,
    );
  }

  return resolved;
}

/**
 * Awaits the handler, or gives up on it.
 *
 * `Promise.race` and not an `AbortSignal`, for the same reason the outbox relay
 * uses one: the handler's contract is a promise and nothing more, so a signal
 * would only be enforceable on handlers that chose to read it — the subset that
 * did not need a backstop. The losing promise stays attached to the race, so a
 * handler that rejects after the timeout has fired does not become an unhandled
 * rejection and take the process down.
 */
async function runWithin(
  handler: StreamHandler,
  envelope: StreamEventEnvelope,
  context: StreamEntryContext,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StreamHandlerTimeoutError(context.entryId, timeoutMs)), timeoutMs);
  });

  try {
    await Promise.race([handler(envelope, context), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function park(
  commands: StreamCommands,
  options: ResolvedOptions,
  parked: ParkedEntry,
): Promise<void> {
  // Park first, acknowledge second. If the parking lot is unavailable this
  // throws, the entry stays pending, and the next reclaim parks it again —
  // whereas acknowledging first would drop it the one time the sink was down.
  await options.onPark(parked);
  await commands.ack(options.key, options.group, [parked.entry.id]);
}

/**
 * Decode, handle, acknowledge — for one batch, from either source.
 *
 * A handler failure is contained per entry rather than abandoning the batch:
 * one poisoned entry must not cost the fifteen beside it their acknowledgements
 * and a redelivery each. A failure from `commands` is different and propagates
 * — the connection is in doubt, and the right move is to end the tick and let
 * the loop retry rather than to keep issuing commands into a broken socket.
 */
async function processEntries(
  entries: readonly StreamEntry[],
  deliveryCounts: ReadonlyMap<string, number>,
  reclaimed: boolean,
  commands: StreamCommands,
  options: ResolvedOptions,
): Promise<StreamTickOutcome> {
  let handled = 0;
  let failed = 0;
  let parked = 0;

  for (const entry of entries) {
    // A fresh read is by definition the first delivery; the pending list is
    // where a count above one comes from.
    const deliveryCount = deliveryCounts.get(entry.id) ?? 1;

    let envelope: StreamEventEnvelope;
    try {
      envelope = decodeEnvelope(entry);
    } catch (error) {
      if (!(error instanceof MalformedStreamEntryError)) throw error;
      // Straight to the parking lot without consuming the ladder: the bytes
      // will not parse differently on the fifth attempt than on the first.
      await park(commands, options, {
        entry,
        reason: 'undecodable',
        lastError: describeFailure(error),
        deliveryCount,
      });
      parked += 1;
      continue;
    }

    try {
      await runWithin(options.handler, envelope, { entryId: entry.id, deliveryCount, reclaimed }, options.handlerTimeoutMs);
    } catch (error) {
      // Not acknowledged, on purpose: the entry stays in the pending list and
      // its idle clock starts again, which *is* the retry schedule. There is no
      // separate backoff timer here because Redis already keeps one per entry,
      // and `minIdleMs` is its interval.
      if (deliveryCount >= options.maxDeliveries) {
        await park(commands, options, {
          entry,
          reason: 'delivery-ceiling',
          lastError: describeFailure(error),
          deliveryCount,
        });
        parked += 1;
      } else {
        options.onError(error);
        failed += 1;
      }
      continue;
    }

    // One `XACK` per entry rather than one per batch. Batching would be fewer
    // round trips and would mean a crash halfway through a batch redelivers
    // every entry in it, including the ones already done — paying for the
    // saving in duplicate work at exactly the moment the system is unhealthy.
    await commands.ack(options.key, options.group, [entry.id]);
    handled += 1;
  }

  return { read: reclaimed ? 0 : entries.length, reclaimed: reclaimed ? entries.length : 0, handled, failed, parked };
}

/**
 * Claim-on-stall: find entries nobody has acknowledged and take them over.
 *
 * Two commands, and the second one repeats the first's idle floor. That
 * repetition is the concurrency control: between the `XPENDING` that selected
 * an id and the `XCLAIM` that takes it, another worker may have claimed the
 * same entry and reset its idle clock. Passing `minIdleMs` again makes the
 * server refuse it — atomically, per entry — so two workers reclaiming in the
 * same instant divide the entries rather than duplicating them. Which is why
 * the claim returning fewer entries than ids is ordinary and not an error.
 *
 * The other reason for a short claim is a trimmed entry: `MAXLEN` can evict an
 * entry that is still pending, leaving the group holding a reference to
 * something that no longer exists. Redis drops that reference when the entry is
 * claimed and returns nothing for it — the one place where work is genuinely
 * lost, and the reason the producer's cap is sized as a safety margin.
 */
async function reclaimStalled(
  commands: StreamCommands,
  options: ResolvedOptions,
): Promise<StreamTickOutcome> {
  const pending = await commands.pendingEntries({
    key: options.key,
    group: options.group,
    minIdleMs: options.minIdleMs,
    count: options.claimBatchSize,
  });

  if (pending.length === 0) return EMPTY_OUTCOME;

  // `+ 1` because the claim about to happen *is* a delivery: `XPENDING`
  // reports the count as it stands, and `XCLAIM` increments it. Passing the
  // pre-claim number would under-report by one to every handler and, worse,
  // let an entry have one more attempt than `maxDeliveries` says.
  const deliveryCounts = new Map(pending.map((entry) => [entry.id, entry.deliveryCount + 1]));

  const claimed = await commands.claim({
    key: options.key,
    group: options.group,
    consumer: options.consumer,
    minIdleMs: options.minIdleMs,
    ids: pending.map((entry) => entry.id),
  });

  return processEntries(claimed, deliveryCounts, true, commands, options);
}

/**
 * One pass: reclaim what has stalled if it is time to, then read what is new.
 *
 * Reclaim first, and only because of what the read does when the stream is
 * empty — it blocks for `blockMs`. Reading first would put that block between
 * every reclaim and the next, so a stalled entry on an otherwise quiet stream
 * would wait for a timeout that exists to *avoid* polling. Recovery is the more
 * urgent of the two anyway: the entries in the pending list are older than
 * anything the read will return.
 */
async function runStreamTick(
  connections: StreamConnections,
  options: ResolvedOptions,
  shouldReclaim: boolean,
): Promise<StreamTickOutcome> {
  const reclaimOutcome = shouldReclaim ? await reclaimStalled(connections.commands, options) : EMPTY_OUTCOME;

  const entries = await connections.blocking.readGroup({
    key: options.key,
    group: options.group,
    consumer: options.consumer,
    count: options.batchSize,
    blockMs: options.blockMs,
  });

  const readOutcome = await processEntries(entries, new Map(), false, connections.commands, options);

  return addOutcome(reclaimOutcome, readOutcome);
}

export interface StreamWorker {
  /** The name this worker holds inside the group. */
  readonly consumer: string;
  /**
   * Creates the group if needed and starts the loop. Resolves once the loop is
   * running, not when it ends.
   */
  start(): Promise<void>;
  /**
   * Stops after the tick in flight, then retires the consumer if it is safe to.
   *
   * Resolving takes up to `blockMs` plus one handler: the read is already
   * blocked on the server when the stop arrives, and dropping the connection to
   * cut that short would abandon a handler mid-entry — the entry would be
   * redelivered and its work repeated, to save a second of shutdown.
   */
  stop(): Promise<void>;
  /** One tick, for a test or a one-shot drain. Requires `ensureGroup` to have run. */
  runOnce(shouldReclaim?: boolean): Promise<StreamTickOutcome>;
  /** `XGROUP CREATE`, idempotent. Called by `start`; exposed for one-shot use. */
  ensureGroup(): Promise<'created' | 'exists'>;
}

export function createStreamWorker(options: StreamWorkerOptions): StreamWorker {
  const resolved = resolveOptions(options);
  const { connections } = options;

  let running = false;
  let stopping = false;
  let loop: Promise<void> | null = null;
  let lastReclaimAt = Number.NEGATIVE_INFINITY;
  let wake: (() => void) | null = null;

  async function ensureGroup(): Promise<'created' | 'exists'> {
    const result = await connections.commands.createGroup(resolved.key, resolved.group, {
      from: '$',
      mkstream: true,
    });
    if (result === 'created') {
      console.log(`[stream worker] created group "${resolved.group}" on "${resolved.key}"`);
    }
    return result;
  }

  /** Resolves `true` when the tick completed, `false` when it threw. */
  async function tick(): Promise<boolean> {
    const now = resolved.now();
    const shouldReclaim = now - lastReclaimAt >= resolved.reclaimIntervalMs;
    if (shouldReclaim) lastReclaimAt = now;

    try {
      resolved.onOutcome(await runStreamTick(connections, resolved, shouldReclaim));
      return true;
    } catch (error) {
      if (isNoGroupError(error)) {
        // The stream or the group disappeared underneath us — a `FLUSHDB`
        // against a shared instance, an `XGROUP DESTROY`, a failover to a
        // replica that never saw the create. Recreating is the only recovery,
        // and it is loud because the new group starts at `$`: entries written
        // while the group did not exist are not delivered to anybody.
        console.error(
          `[stream worker] group "${resolved.group}" on "${resolved.key}" is gone; recreating. ` +
            `Entries written while it was missing will not be delivered.`,
        );
        await ensureGroup();
        return false;
      }
      // Everything else — a dropped connection, an unparseable reply — is
      // logged and the loop continues. There is nothing to escalate to: this is
      // a background process with no request to fail, and exiting would trade a
      // recoverable blip for a container restart.
      resolved.onError(error);
      return false;
    }
  }

  /**
   * The pause after a failed tick, cut short by a stop.
   *
   * Interruptible because it is otherwise the *other* floor on shutdown, and a
   * much worse one than the block: an escalating ladder reaching its ceiling
   * means a `SIGTERM` arriving during an outage waits half a minute before the
   * process notices, which an orchestrator answers with `SIGKILL`. Waking the
   * sleeper on stop keeps the drain bounded by the block and one handler,
   * whether or not Redis is reachable.
   */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }

  return {
    consumer: resolved.consumer,
    ensureGroup,

    async start(): Promise<void> {
      if (running) return;
      running = true;
      stopping = false;

      await ensureGroup();

      loop = (async () => {
        let consecutiveFailures = 0;

        while (!stopping) {
          if (await tick()) {
            consecutiveFailures = 0;
            continue;
          }

          // A failing tick usually fails instantly — a read against an
          // unreachable server rejects rather than blocking — so without this
          // the loop is a busy wait for the length of the outage. The ladder
          // is the relay's, jitter included, for the same reason: every
          // consumer failed at the same instant.
          consecutiveFailures += 1;
          const delayMs = fullJitterDelay(consecutiveFailures, {
            baseMs: resolved.errorBackoffMs,
            maxMs: resolved.maxErrorBackoffMs,
            random: resolved.random,
          });
          // Even a zero-length pause is awaited: `sleep(0)` is a macrotask, and
          // yielding one is what keeps a tick that fails synchronously — a
          // rejected read against a closed socket — from starving the timers
          // the rest of the process runs on.
          if (!stopping) await sleep(delayMs);
        }
      })();
    },

    async runOnce(shouldReclaim = true): Promise<StreamTickOutcome> {
      return runStreamTick(connections, resolved, shouldReclaim);
    },

    async stop(): Promise<void> {
      if (!running) return;
      stopping = true;
      // Cuts short a backoff pause rather than waiting it out. See `sleep`.
      wake?.();
      await loop;
      loop = null;
      running = false;

      // Retiring the consumer keeps `XINFO CONSUMERS` from accumulating a row
      // per replica that ever existed. It is conditional because
      // `XGROUP DELCONSUMER` does not hand a consumer's pending entries to
      // anybody — it deletes them, and the work they represent is never
      // redelivered. So it happens only when there is nothing left to lose;
      // otherwise the entries are left for another consumer to reclaim on idle
      // time, and this consumer's row is tidied up by whoever restarts it.
      try {
        const stillPending = await connections.commands.consumerPendingCount(
          resolved.key,
          resolved.group,
          resolved.consumer,
        );

        if (stillPending === 0) {
          await connections.commands.deleteConsumer(resolved.key, resolved.group, resolved.consumer);
        } else {
          console.warn(
            `[stream worker] leaving consumer "${resolved.consumer}" in place with ` +
              `${stillPending} pending entr${stillPending === 1 ? 'y' : 'ies'}; another consumer ` +
              `will reclaim them after ${resolved.minIdleMs}ms`,
          );
        }
      } catch (error) {
        // Shutdown is not a place to throw. Redis being unreachable here costs
        // a stale consumer row, which the next start reuses by name anyway.
        resolved.onError(error);
      }
    },
  };
}
