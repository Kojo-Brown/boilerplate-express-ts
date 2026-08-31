import { SseEventLog } from '@/sse/event-log';

const STREAM = 'testrun';

function logOf(capacity: number, appends = 0): SseEventLog {
  const log = new SseEventLog({ capacity, streamId: STREAM });
  for (let i = 1; i <= appends; i += 1) {
    log.append('tick', `{"n":${i}}`);
  }
  return log;
}

/** The data payloads of a replay outcome, or a description of why there was not one. */
function replayed(log: SseEventLog, cursor: string | undefined): unknown {
  const outcome = log.since(cursor);
  return outcome.kind === 'replay' ? outcome.messages.map((m) => m.data) : outcome;
}

describe('SseEventLog construction', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects a capacity of %p', (capacity) => {
    expect(() => new SseEventLog({ capacity })).toThrow(RangeError);
  });

  it('rejects a stream id containing the separator, which would make ids ambiguous', () => {
    expect(() => new SseEventLog({ capacity: 4, streamId: 'a:b' })).toThrow(RangeError);
  });

  it('mints its own stream id when none is supplied, and a different one each time', () => {
    const first = new SseEventLog({ capacity: 4 });
    const second = new SseEventLog({ capacity: 4 });
    expect(first.streamId).toMatch(/^[0-9a-f]{16}$/);
    expect(first.streamId).not.toBe(second.streamId);
  });
});

describe('SseEventLog.append', () => {
  it('has no latest event id before the first append', () => {
    expect(logOf(4).latestEventId).toBeUndefined();
  });

  it('numbers events from 1, under the stream prefix', () => {
    const log = logOf(4);
    expect(log.append('tick', '{}').id).toBe(`${STREAM}:1`);
    expect(log.append('tick', '{}').id).toBe(`${STREAM}:2`);
    expect(log.latestEventId).toBe(`${STREAM}:2`);
  });

  it('keeps counting past the capacity — the sequence is not the slot', () => {
    const log = logOf(2, 5);
    expect(log.latestEventId).toBe(`${STREAM}:5`);
  });

  it('returns the message it stored, event name and all', () => {
    expect(logOf(4).append('user.created', '{"a":1}')).toEqual({
      id: `${STREAM}:1`,
      event: 'user.created',
      data: '{"a":1}',
    });
  });
});

describe('SseEventLog.since', () => {
  it('treats a first connection as live rather than as something to re-sync', () => {
    expect(logOf(4, 3).since(undefined)).toEqual({ kind: 'live' });
  });

  it('is live for a client already holding the latest event', () => {
    expect(logOf(4, 3).since(`${STREAM}:3`)).toEqual({ kind: 'live' });
  });

  it('replays exactly the events after the cursor', () => {
    expect(replayed(logOf(8, 4), `${STREAM}:2`)).toEqual(['{"n":3}', '{"n":4}']);
  });

  it('replays everything for a cursor at the very start of a log that has not wrapped', () => {
    expect(replayed(logOf(8, 3), `${STREAM}:1`)).toEqual(['{"n":2}', '{"n":3}']);
  });

  it('replays the whole retained window when the cursor is the last evicted event', () => {
    // The boundary the off-by-one lives at. Capacity 3 after 5 appends retains
    // 3, 4 and 5; a client holding 2 is owed exactly those and is still
    // serviceable, even though event 2 itself is gone.
    expect(replayed(logOf(3, 5), `${STREAM}:2`)).toEqual(['{"n":3}', '{"n":4}', '{"n":5}']);
  });

  it('resets one event further back, where the gap can no longer be filled', () => {
    expect(logOf(3, 5).since(`${STREAM}:1`)).toEqual({ kind: 'reset', reason: 'expired' });
  });

  it('resets a cursor from a different run of the process', () => {
    // The failure this prevents is silent: with a bare sequence, a cursor of 2
    // taken before a restart would name a real event in the new run, and both
    // sides would believe the resume worked while the client silently skipped
    // everything the previous run had sent it.
    const log = logOf(8, 4);
    expect(log.since('otherrun:2')).toEqual({ kind: 'reset', reason: 'unknown-stream' });
  });

  it.each([
    ['no separator', '12'],
    ['an empty sequence', `${STREAM}:`],
    ['a non-numeric sequence', `${STREAM}:abc`],
    ['a number with a trailing tail parseInt would have accepted', `${STREAM}:12abc`],
    ['a negative sequence', `${STREAM}:-3`],
    ['a zero sequence, which is below the first event', `${STREAM}:0`],
    ['a fractional sequence', `${STREAM}:1.5`],
  ])('resets a cursor with %s', (_label, cursor) => {
    expect(logOf(8, 4).since(cursor)).toEqual({ kind: 'reset', reason: 'malformed' });
  });

  it('treats a cursor ahead of this log as live rather than as an error', () => {
    // Reachable without a bug: a proxy sends the reconnect to a peer that has
    // served fewer events. There is nothing to replay and nothing missing.
    expect(logOf(8, 2).since(`${STREAM}:9`)).toEqual({ kind: 'live' });
  });

  it('is live against an empty log, whatever the cursor claims', () => {
    expect(logOf(4).since(`${STREAM}:1`)).toEqual({ kind: 'live' });
  });

  it('serves a capacity-1 log, where every cursor but the latest has expired', () => {
    const log = logOf(1, 3);
    expect(log.since(`${STREAM}:3`)).toEqual({ kind: 'live' });
    expect(replayed(log, `${STREAM}:2`)).toEqual(['{"n":3}']);
    expect(log.since(`${STREAM}:1`)).toEqual({ kind: 'reset', reason: 'expired' });
  });

  it('still replays correctly after the ring has wrapped many times over', () => {
    // The slot for a sequence is `sequence % capacity`, so a wrap is where an
    // index error would first show up as replaying an event from a lap ago.
    const log = logOf(4, 101);
    expect(replayed(log, `${STREAM}:99`)).toEqual(['{"n":100}', '{"n":101}']);
  });
});
