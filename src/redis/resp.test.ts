import { UnexpectedRedisReplyError } from '@/redis/redis.errors';
import {
  parseEntries,
  parseFieldArray,
  parsePendingEntries,
  parsePendingSummaryFor,
  parseReadGroupReply,
  toFieldArguments,
} from '@/redis/resp';

/**
 * The fixtures here are transcripts, not inventions: each one is a reply
 * captured from Redis 7 for the command it is named after. That is what makes
 * this suite worth having — it is the only place the parsers are pinned to what
 * a server actually sends rather than to what the parser expects.
 */

describe('parseFieldArray', () => {
  it('pairs a flat array into a record', () => {
    expect(parseFieldArray(['name', 'user.created', 'data', '{"a":1}'], 'XADD')).toEqual({
      name: 'user.created',
      data: '{"a":1}',
    });
  });

  it('accepts an empty field list', () => {
    expect(parseFieldArray([], 'XADD')).toEqual({});
  });

  it('rejects an odd-length array instead of dropping the last name', () => {
    // Silently producing `{ name: undefined }` is how a corrupt reply becomes a
    // payload with a missing field three modules away.
    expect(() => parseFieldArray(['name'], 'XADD')).toThrow(UnexpectedRedisReplyError);
  });

  it('keeps the last value when a field name repeats', () => {
    expect(parseFieldArray(['k', 'first', 'k', 'second'], 'XADD')).toEqual({ k: 'second' });
  });

  it('stringifies an integer reply in a value position', () => {
    expect(parseFieldArray(['count', 3], 'XADD')).toEqual({ count: '3' });
  });

  it('names the command it failed on', () => {
    expect(() => parseFieldArray('not an array', 'XCLAIM')).toThrow(/XCLAIM/);
  });
});

describe('parseEntries', () => {
  it('parses an XCLAIM reply', () => {
    const reply = [
      ['1788526829455-0', ['name', 'a', 'data', '1']],
      ['1788526829456-0', ['name', 'b', 'data', '2']],
    ];

    expect(parseEntries(reply, 'XCLAIM')).toEqual([
      { id: '1788526829455-0', fields: { name: 'a', data: '1' } },
      { id: '1788526829456-0', fields: { name: 'b', data: '2' } },
    ]);
  });

  it('parses an empty claim — the ordinary reply when every id was refused', () => {
    expect(parseEntries([], 'XCLAIM')).toEqual([]);
  });

  it('rejects an entry that is not an [id, fields] pair', () => {
    expect(() => parseEntries(['1788526829455-0'], 'XCLAIM')).toThrow(UnexpectedRedisReplyError);
  });
});

describe('parseReadGroupReply', () => {
  it('parses the RESP2 array-of-pairs reply', () => {
    const reply = [
      [
        'domain-events',
        [['1788526783579-0', ['name', 'user.created', 'data', '{"a":1}']]],
      ],
    ];

    expect(parseReadGroupReply(reply, 'XREADGROUP')).toEqual([
      { id: '1788526783579-0', fields: { name: 'user.created', data: '{"a":1}' } },
    ]);
  });

  it('parses the RESP3 flattened-map reply', () => {
    // What `call('XREADGROUP', …)` actually returns against Redis 7 over a
    // connection that negotiated RESP3 — which is `ioredis`'s default, and the
    // shape the adapter sees in production. A parser written for the pair form
    // alone passes every fake and silently reads nothing here.
    const reply = ['domain-events', [['1788526783579-0', ['name', 'user.created', 'data', '{"a":1}']]]];

    expect(parseReadGroupReply(reply, 'XREADGROUP')).toEqual([
      { id: '1788526783579-0', fields: { name: 'user.created', data: '{"a":1}' } },
    ]);
  });

  it('flattens every stream in a RESP3 reply', () => {
    const reply = ['other', [['1-1', ['k', 'v']]], 'domain-events', [['2-1', ['k', 'w']]]];

    expect(parseReadGroupReply(reply, 'XREADGROUP').map((entry) => entry.id)).toEqual(['1-1', '2-1']);
  });

  it('rejects an odd-length flattened map rather than dropping a stream', () => {
    expect(() => parseReadGroupReply(['domain-events'], 'XREADGROUP')).toThrow(UnexpectedRedisReplyError);
  });

  it('treats an empty array as an empty read', () => {
    expect(parseReadGroupReply([], 'XREADGROUP')).toEqual([]);
  });

  it('treats null as an empty read rather than as a failure', () => {
    // This is what an idle consumer gets on every block expiry. Throwing here
    // would make the steady state an exception.
    expect(parseReadGroupReply(null, 'XREADGROUP')).toEqual([]);
  });

  it('flattens every stream in the reply instead of assuming the first is ours', () => {
    const reply = [
      ['other', [['1-1', ['k', 'v']]]],
      ['domain-events', [['2-1', ['k', 'w']]]],
    ];

    expect(parseReadGroupReply(reply, 'XREADGROUP').map((entry) => entry.id)).toEqual(['1-1', '2-1']);
  });
});

describe('parsePendingEntries', () => {
  it('parses the extended XPENDING reply', () => {
    const reply = [
      ['1788526829455-0', 'c1', 2, 1],
      ['1788526829456-0', 'c1', 30_012, 4],
    ];

    expect(parsePendingEntries(reply, 'XPENDING')).toEqual([
      { id: '1788526829455-0', consumer: 'c1', idleMs: 2, deliveryCount: 1 },
      { id: '1788526829456-0', consumer: 'c1', idleMs: 30_012, deliveryCount: 4 },
    ]);
  });

  it('accepts counts sent as bulk strings', () => {
    const [entry] = parsePendingEntries([['1-1', 'c1', '5', '2']], 'XPENDING');

    expect(entry).toEqual({ id: '1-1', consumer: 'c1', idleMs: 5, deliveryCount: 2 });
  });

  it('rejects a delivery count that is not a number', () => {
    // The poison ceiling is read off this field. A `NaN` there compares false
    // against every bound, so a poisoned entry would be retried forever.
    expect(() => parsePendingEntries([['1-1', 'c1', 5, 'many']], 'XPENDING')).toThrow(
      UnexpectedRedisReplyError,
    );
  });
});

describe('parsePendingSummaryFor', () => {
  it('finds a consumer in the per-consumer tally', () => {
    const reply = [2, '1788526783579-0', '1788526783580-0', [['c2', '2']]];

    expect(parsePendingSummaryFor(reply, 'c2', 'XPENDING')).toBe(2);
  });

  it('returns 0 for a consumer that is not listed', () => {
    expect(parsePendingSummaryFor([2, '1-1', '2-1', [['c2', '2']]], 'c9', 'XPENDING')).toBe(0);
  });

  it('handles the null tail an empty group answers with', () => {
    // `[0, null, null, null]` is what a healthy group returns, and a `.find` on
    // that tail is a TypeError during shutdown — the one moment nothing should
    // throw.
    expect(parsePendingSummaryFor([0, null, null, null], 'c1', 'XPENDING')).toBe(0);
  });
});

describe('toFieldArguments', () => {
  it('flattens a record into name/value arguments', () => {
    expect(toFieldArguments({ b: '2', a: '1' })).toEqual(['a', '1', 'b', '2']);
  });

  it('orders by field name so the arguments do not depend on insertion order', () => {
    expect(toFieldArguments({ z: '1', a: '2' })).toEqual(toFieldArguments({ a: '2', z: '1' }));
  });

  it('produces nothing for an empty record', () => {
    expect(toFieldArguments({})).toEqual([]);
  });
});
