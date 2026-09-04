import { UnexpectedRedisReplyError } from '@/redis/redis.errors';

/**
 * Reply parsing for the stream commands: nested RESP arrays in, typed values
 * out.
 *
 * Everything here is pure and takes `unknown`, which is the honest type for a
 * reply. A Redis client hands back whatever the server sent, and the server's
 * answer is a function of its *version* — the same command answers with a
 * two-element array on one release and a three-element array on the next. Code
 * that indexes into a reply inline is therefore asserting a server version it
 * never checked, at every call site, with no error path when the assertion is
 * wrong: `reply[0][1]` on a shape that changed is `undefined`, and `undefined`
 * flows on to fail somewhere with no connection to the reply that produced it.
 *
 * So each parser states the shape it expects and throws naming the command when
 * it does not get it. That failure reaches the worker's error handler, which
 * logs it and retries the tick — the right response to "this server is not the
 * one this code was written against", as opposed to a `TypeError` three modules
 * away.
 */

function asArray(reply: unknown, command: string, what: string): readonly unknown[] {
  if (!Array.isArray(reply)) {
    throw new UnexpectedRedisReplyError(command, `expected an array for ${what}, got ${typeof reply}`);
  }
  return reply;
}

/**
 * Bulk strings arrive as strings; integers as numbers. Both are stringified
 * here rather than rejected, because which of the two a field is depends on the
 * command — `XPENDING` answers with an integer delivery count and `XINFO` with
 * a bulk string for the same kind of value — and the callers all want text.
 */
function asString(reply: unknown, command: string, what: string): string {
  if (typeof reply === 'string') return reply;
  if (typeof reply === 'number') return String(reply);
  throw new UnexpectedRedisReplyError(command, `expected a string for ${what}, got ${typeof reply}`);
}

/**
 * Redis integers arrive as numbers, but counts that are part of a *nested*
 * reply frequently arrive as bulk strings instead — the per-consumer tallies in
 * an `XPENDING` summary are strings while the total beside them is an integer.
 * Accepting both is not laxness; it is the protocol.
 */
function asInteger(reply: unknown, command: string, what: string): number {
  const value = typeof reply === 'string' ? Number(reply) : reply;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UnexpectedRedisReplyError(command, `expected an integer for ${what}, got ${String(reply)}`);
  }
  return value;
}

export interface RawStreamEntry {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * `[field, value, field, value, …]` to a record.
 *
 * A stream entry's fields are a flat array because that is how the protocol
 * carries a map, and an odd-length one is a corrupt reply rather than a field
 * with a missing value — worth failing on, since the alternative is a silent
 * `undefined` in a payload.
 *
 * A duplicate field name keeps the last value, matching `XADD`'s own behaviour:
 * the entry is stored with both, and every reader of the record form has to
 * pick one.
 */
export function parseFieldArray(reply: unknown, command: string): Readonly<Record<string, string>> {
  const flat = asArray(reply, command, 'entry fields');

  if (flat.length % 2 !== 0) {
    throw new UnexpectedRedisReplyError(
      command,
      `entry fields must be name/value pairs, got ${flat.length} element(s)`,
    );
  }

  const fields: Record<string, string> = {};
  for (let index = 0; index < flat.length; index += 2) {
    const name = asString(flat[index], command, 'field name');
    fields[name] = asString(flat[index + 1], command, `value of field "${name}"`);
  }
  return fields;
}

/** `[[id, [field, value, …]], …]` — the entry list shared by `XCLAIM` and `XREADGROUP`. */
export function parseEntries(reply: unknown, command: string): readonly RawStreamEntry[] {
  return asArray(reply, command, 'entries').map((element) => {
    const pair = asArray(element, command, 'entry');
    return {
      id: asString(pair[0], command, 'entry id'),
      fields: parseFieldArray(pair[1], command),
    };
  });
}

/**
 * `XREADGROUP`'s reply, in either of the two shapes a server may send it in, or
 * `null` when the block expired with nothing to read.
 *
 * The reply is keyed by stream because one `XREADGROUP` can read several at
 * once, and **how** it is keyed depends on the protocol the connection
 * negotiated:
 *
 * - RESP2 sends an array of `[key, entries]` pairs.
 * - RESP3 sends a map, which a client without a reply transformer surfaces as
 *   a flat `[key, entries, key, entries, …]`.
 *
 * Both arrive here, from the same code, against the same server: `ioredis`
 * applies a per-command transformer to its typed `xreadgroup` helper and none
 * to `call`, and it negotiates RESP3 by default. This is exactly the divergence
 * the module docstring is about, and it was found by running the adapter
 * against a real server rather than by reading either document — a parser
 * written for one shape passes every fake and returns nothing on the other.
 *
 * The keys are dropped, but only after both shapes are flattened, so a server
 * returning streams in an order nobody promised cannot deliver another stream's
 * entries as this one's.
 *
 * `null` is the *ordinary* case, not an error: an idle consumer gets one on
 * every block, which is what makes an empty return distinguishable from a
 * failure without an exception per timeout.
 */
export function parseReadGroupReply(reply: unknown, command: string): readonly RawStreamEntry[] {
  if (reply === null || reply === undefined) return [];

  const top = asArray(reply, command, 'streams');
  if (top.length === 0) return [];

  // A string in the first slot is a stream *key*, so this is the flattened map
  // form; an array there is a `[key, entries]` pair.
  if (typeof top[0] === 'string') {
    if (top.length % 2 !== 0) {
      throw new UnexpectedRedisReplyError(
        command,
        `flattened stream map must be key/entries pairs, got ${top.length} element(s)`,
      );
    }

    const entries: RawStreamEntry[] = [];
    for (let index = 1; index < top.length; index += 2) {
      entries.push(...parseEntries(top[index], command));
    }
    return entries;
  }

  return top.flatMap((element) => parseEntries(asArray(element, command, 'stream')[1], command));
}

export interface RawPendingEntry {
  readonly id: string;
  readonly consumer: string;
  readonly idleMs: number;
  readonly deliveryCount: number;
}

/** `[[id, consumer, idleMs, deliveryCount], …]` — `XPENDING`'s extended form. */
export function parsePendingEntries(reply: unknown, command: string): readonly RawPendingEntry[] {
  return asArray(reply, command, 'pending entries').map((element) => {
    const row = asArray(element, command, 'pending entry');
    return {
      id: asString(row[0], command, 'pending entry id'),
      consumer: asString(row[1], command, 'pending entry consumer'),
      idleMs: asInteger(row[2], command, 'pending entry idle time'),
      deliveryCount: asInteger(row[3], command, 'pending entry delivery count'),
    };
  });
}

/**
 * How many entries one consumer holds, out of `XPENDING`'s summary form
 * `[total, minId, maxId, [[consumer, count], …]]`.
 *
 * The per-consumer list is `null` — not an empty array — when the group has
 * nothing pending at all, which is the shape a healthy group answers with and
 * therefore the one a naive `.find` crashes on.
 */
export function parsePendingSummaryFor(reply: unknown, consumer: string, command: string): number {
  const summary = asArray(reply, command, 'pending summary');
  const perConsumer = summary[3];

  if (perConsumer === null || perConsumer === undefined) return 0;

  for (const element of asArray(perConsumer, command, 'per-consumer counts')) {
    const row = asArray(element, command, 'per-consumer count');
    if (asString(row[0], command, 'consumer name') === consumer) {
      return asInteger(row[1], command, 'consumer pending count');
    }
  }

  return 0;
}

/**
 * A record to the flat `field value field value` argument list `XADD` takes.
 *
 * Sorted by field name so the arguments are a function of the record and not of
 * its insertion order. Nothing in Redis cares, but an assertion on the command
 * a producer issued does, and a test that has to know how an object literal was
 * built is a test that breaks when someone reorders two lines.
 */
export function toFieldArguments(fields: Readonly<Record<string, string>>): string[] {
  return Object.keys(fields)
    .sort()
    .flatMap((name) => [name, fields[name] ?? '']);
}
