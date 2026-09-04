import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { isBusyGroupError } from '@/redis/redis.errors';
import {
  parseEntries,
  parsePendingEntries,
  parsePendingSummaryFor,
  parseReadGroupReply,
  toFieldArguments,
} from '@/redis/resp';
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
 * `StreamCommands` over `ioredis`.
 *
 * ## Why every command goes through `call`
 *
 * `ioredis` ships typed helpers for these commands, and they are not usable
 * here. `xclaim` alone has some sixty overloads enumerating the optional
 * tokens, none of which accepts a *dynamically sized* id list followed by
 * nothing — spreading an array into that signature resolves to the overload
 * with the fewest constraints and returns `unknown[]` anyway. So the choice is
 * between a cast at each call site to satisfy an overload that does not fit,
 * and one honest `call(command, args)` per method whose reply is parsed by a
 * tested function. The parsing has to exist either way: the helpers do not
 * decode the nested arrays, they only re-type them.
 *
 * That also keeps the client swappable. Nothing above this file imports
 * `ioredis`, and the port is seven methods, so moving to `node-redis` or to a
 * cluster client is this file plus its tests.
 */
class IoredisStreamCommands implements StreamCommands {
  constructor(
    private readonly redis: Redis,
    /**
     * Resolves once the connection has completed its handshake.
     *
     * Needed because of `enableOfflineQueue: false` below, which is right for a
     * *reconnect* and wrong for the first connect: with the queue off, a
     * command issued in the window between `new Redis()` and the connection
     * becoming writeable fails outright with "Stream isn't writeable" — and the
     * first thing every consumer does is create its group, microseconds after
     * construction. Turning the queue back on to fix that would reintroduce the
     * problem it was turned off for, so the wait lives here instead, where it
     * costs an already-resolved promise per command after the first.
     *
     * It has no timeout on purpose: `maxRetriesPerRequest: null` already says
     * this client rides out an outage rather than failing commands, and the
     * callers that need a deadline have one — the relay's dispatch timeout
     * bounds the API side, and the worker has no request waiting on it.
     */
    private readonly ready: Promise<void>,
  ) {}

  private async send(command: string, args: (string | number)[]): Promise<unknown> {
    await this.ready;
    return this.redis.call(command, args);
  }

  async createGroup(key: string, group: string, options: CreateGroupOptions = {}): Promise<'created' | 'exists'> {
    const { from = '$', mkstream = true } = options;
    const args: (string | number)[] = ['CREATE', key, group, from];
    if (mkstream) args.push('MKSTREAM');

    try {
      await this.send('XGROUP', args);
      return 'created';
    } catch (error) {
      // The expected reply on every boot after the first. See `isBusyGroupError`
      // for why this is the idempotence rather than a check-then-act.
      if (isBusyGroupError(error)) return 'exists';
      throw error;
    }
  }

  async append(
    key: string,
    fields: Readonly<Record<string, string>>,
    options: AppendOptions = {},
  ): Promise<string> {
    const { maxLen, approximate = true } = options;
    const args: (string | number)[] = [key];

    if (maxLen !== undefined) {
      args.push('MAXLEN');
      if (approximate) args.push('~');
      args.push(maxLen);
    }

    // `*` asks the server to assign the id. A client-generated id would have to
    // be greater than every id already in the stream — across every replica of
    // every producer — which is a distributed clock problem in exchange for
    // nothing, since the id a consumer deduplicates on is inside the envelope.
    args.push('*', ...toFieldArguments(fields));

    const reply = await this.send('XADD', args);
    if (typeof reply !== 'string') {
      throw new TypeError(`Unexpected XADD reply: expected an id, got ${typeof reply}`);
    }
    return reply;
  }

  async readGroup(options: ReadGroupOptions): Promise<readonly StreamEntry[]> {
    const { key, group, consumer, count, blockMs } = options;
    const reply = await this.send('XREADGROUP', [
      'GROUP',
      group,
      consumer,
      'COUNT',
      count,
      'BLOCK',
      blockMs,
      'STREAMS',
      key,
      // Never an explicit id: see `StreamCommands.readGroup`. An id here reads
      // this consumer's own pending list instead of the stream.
      '>',
    ]);
    return parseReadGroupReply(reply, 'XREADGROUP');
  }

  async ack(key: string, group: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const reply = await this.send('XACK', [key, group, ...ids]);
    return typeof reply === 'number' ? reply : 0;
  }

  async pendingEntries(options: {
    readonly key: string;
    readonly group: string;
    readonly minIdleMs: number;
    readonly count: number;
    readonly startExclusiveOf?: string;
  }): Promise<readonly PendingEntry[]> {
    const { key, group, minIdleMs, count, startExclusiveOf } = options;
    const reply = await this.send('XPENDING', [
      key,
      group,
      // The idle filter is applied by the server, so a group with a hundred
      // thousand healthy in-flight entries costs the same scan as an empty one
      // — as opposed to fetching a page and filtering it here, which pages
      // through entries that were never candidates.
      'IDLE',
      minIdleMs,
      startExclusiveOf === undefined ? '-' : `(${startExclusiveOf}`,
      '+',
      count,
    ]);
    return parsePendingEntries(reply, 'XPENDING');
  }

  async claim(options: ClaimOptions): Promise<readonly StreamEntry[]> {
    const { key, group, consumer, minIdleMs, ids } = options;
    if (ids.length === 0) return [];

    const reply = await this.send('XCLAIM', [key, group, consumer, minIdleMs, ...ids]);
    return parseEntries(reply, 'XCLAIM');
  }

  async consumerPendingCount(key: string, group: string, consumer: string): Promise<number> {
    const reply = await this.send('XPENDING', [key, group]);
    return parsePendingSummaryFor(reply, consumer, 'XPENDING');
  }

  async deleteConsumer(key: string, group: string, consumer: string): Promise<number> {
    const reply = await this.send('XGROUP', ['DELCONSUMER', key, group, consumer]);
    return typeof reply === 'number' ? reply : 0;
  }
}

/**
 * Connection settings shared by both connections.
 *
 * `maxRetriesPerRequest: null` is the one that matters and it looks wrong at
 * first glance. `ioredis` defaults to failing a command after 20 reconnection
 * attempts, which is the right behaviour for a request path — a route waiting
 * on Redis should give up and answer the client rather than hold the socket
 * open through an outage. A consumer has no client waiting: its correct
 * response to "Redis is down" is to keep trying until it comes back, and a
 * blocking `XREADGROUP` that gets aborted mid-block by the retry counter turns
 * a recoverable outage into a crash loop.
 *
 * `enableOfflineQueue: false` is the counterpart. Queuing commands while
 * disconnected would let an `XACK` for an entry sit in memory and be sent after
 * a reconnect — by which time its idle time has run out and another consumer
 * has claimed it, so the ack lands on an entry this worker no longer owns.
 * Failing the command instead surfaces it as a handler failure, and the entry
 * is redelivered, which is the contract.
 */
function connectionOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    // Named so `CLIENT LIST` and `redis-cli info clients` say which process a
    // connection belongs to. Free, and the difference between diagnosing a
    // connection leak in minutes and by elimination.
    connectionName: 'stream-consumer',
  };
}

/**
 * The two connections a consumer needs.
 *
 * Two, and never one: a blocking `XREADGROUP` owns its connection for the
 * duration of the block, so an `XACK` sent on the same one waits behind it. See
 * `StreamConnections`.
 *
 * `duplicate()` rather than a second constructor call so the second connection
 * inherits the URL, TLS settings and auth of the first — the alternative is two
 * call sites that must be kept in agreement, and the failure when they drift is
 * a consumer that reads from one instance and acknowledges to another.
 */
export function createStreamConnections(url: string): StreamConnections & { close(): Promise<void> } {
  const commands = new Redis(url, connectionOptions());
  const blocking = commands.duplicate();

  const whenReady = (redis: Redis): Promise<void> =>
    redis.status === 'ready'
      ? Promise.resolve()
      : new Promise((resolve) => redis.once('ready', () => resolve()));

  // Without a listener, `ioredis` emits `error` on an `EventEmitter` with none
  // attached, which Node turns into an uncaught exception that takes the
  // process down — during exactly the outage the retry strategy above exists to
  // ride out.
  const log = (which: string) => (error: Error) => {
    console.error(`[redis:${which}]`, error.message);
  };
  commands.on('error', log('commands'));
  blocking.on('error', log('blocking'));

  return {
    commands: new IoredisStreamCommands(commands, whenReady(commands)),
    blocking: new IoredisStreamCommands(blocking, whenReady(blocking)),
    async close(): Promise<void> {
      // `quit` sends QUIT and waits for the server to close, which flushes any
      // command still in flight — an `XACK` issued by the last handler, most
      // importantly. `disconnect()` would drop it and leave the entry pending
      // for another consumer to reclaim and run a second time.
      //
      // The blocking connection is the exception: it may be parked in a block
      // for up to `blockMs`, and QUIT waits behind it. The worker stops it
      // before calling this, so the block has already returned.
      await Promise.allSettled([commands.quit(), blocking.quit()]);
    },
  };
}
