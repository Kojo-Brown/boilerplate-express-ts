import { PassThrough } from 'node:stream';
import type { Request, Response } from 'express';
import { openSseConnection } from '@/sse/connection';
import type { SseCloseReason, SseConnection, SseConnectionOptions } from '@/sse/connection';
import type { StreamMessage } from '@/sse/event-log';

/**
 * A response backed by a real stream rather than by `jest.fn()`s.
 *
 * The point is `writableLength`. The slow-consumer rule is a statement about
 * Node's stream buffering — bytes accumulating in this process because the peer
 * is not reading — and a mock whose `write` records calls and returns `true`
 * cannot express it: every assertion about backpressure would be an assertion
 * about the mock. A `PassThrough` nobody reads from fills for the same reason a
 * socket nobody reads from does.
 *
 * `highWaterMark: 1` is what makes it fill on the second write instead of the
 * two-thousandth; the mechanism is the same at 16 KB and the test would take
 * 16 KB of events to reach it.
 */
class FakeResponse extends PassThrough {
  statusCode = 0;
  readonly headers = new Map<string, string>();
  flushed = false;

  constructor() {
    super({ highWaterMark: 1 });
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  flushHeaders(): void {
    this.flushed = true;
  }
}

interface Harness {
  readonly res: FakeResponse;
  readonly req: Request;
  /** Everything written so far, once drained. Empty unless `drain()` was called. */
  written(): string;
  drain(): void;
  readonly socketCalls: { timeout: number[]; noDelay: boolean[] };
}

function harness(): Harness {
  const res = new FakeResponse();
  const chunks: string[] = [];
  const socketCalls = { timeout: [] as number[], noDelay: [] as boolean[] };

  const req = {
    socket: {
      setTimeout: (ms: number): void => void socketCalls.timeout.push(ms),
      setNoDelay: (enable: boolean): void => void socketCalls.noDelay.push(enable),
    },
  } as unknown as Request;

  return {
    res,
    req,
    written: (): string => chunks.join(''),
    drain: (): void => {
      res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    },
    socketCalls,
  };
}

const OPTIONS: SseConnectionOptions = {
  heartbeatIntervalMs: 1000,
  retryMs: 2500,
  maxBufferedBytes: 4096,
};

function open(h: Harness, overrides: Partial<SseConnectionOptions> = {}): SseConnection {
  return openSseConnection(h.req, h.res as unknown as Response, { ...OPTIONS, ...overrides });
}

const message = (id: string, event: string, data: string): StreamMessage => ({ id, event, data });

afterEach(() => {
  jest.useRealTimers();
});

describe('openSseConnection: taking over the response', () => {
  it('commits 200 with the headers an event stream needs, and flushes them', () => {
    const h = harness();
    h.drain();
    open(h);

    expect(h.res.statusCode).toBe(200);
    expect(h.res.getHeader('content-type')).toBe('text/event-stream; charset=utf-8');
    // `no-transform` and not merely `no-cache`: a compressing intermediary may
    // buffer a body to compress it, and a buffered event stream delivers
    // nothing until it ends — which for this response is never.
    expect(h.res.getHeader('cache-control')).toBe('no-cache, no-transform');
    expect(h.res.getHeader('x-accel-buffering')).toBe('no');
    // Before the first event, so a client's `open` fires when the stream opens
    // rather than when something first happens to be published.
    expect(h.res.flushed).toBe(true);
  });

  it('clears the socket timeout and disables Nagle', () => {
    const h = harness();
    h.drain();
    open(h);

    // Without the first, Node's own idle timeout ends a response that is
    // behaving exactly as designed. Without the second, a 40-byte heartbeat
    // waits up to 40ms for company that is not coming.
    expect(h.socketCalls.timeout).toEqual([0]);
    expect(h.socketCalls.noDelay).toEqual([true]);
  });

  it('advertises the reconnection delay first, before anything else is written', () => {
    const h = harness();
    h.drain();
    open(h, { retryMs: 7000 });

    expect(h.written()).toBe('retry: 7000\n\n');
  });

  it.each([
    ['heartbeatIntervalMs', { heartbeatIntervalMs: 0 }],
    ['maxBufferedBytes', { maxBufferedBytes: 0 }],
  ])('refuses to open with an unusable %s', (_label, overrides) => {
    expect(() => open(harness(), overrides)).toThrow(RangeError);
  });
});

describe('openSseConnection: writing', () => {
  it('writes an event with its id, so the client cursor advances', () => {
    const h = harness();
    h.drain();
    const connection = open(h);

    connection.send(message('run:1', 'user.created', '{"a":1}'));

    expect(h.written()).toContain('id: run:1\nevent: user.created\ndata: {"a":1}\n\n');
  });

  it('writes a control event without an id, so the client cursor does not', () => {
    // A control frame names no position in the replay log. Advancing the cursor
    // onto one would make the next reconnect resume from an id `since` cannot
    // place, which is a reset the client did not need.
    const h = harness();
    h.drain();
    const connection = open(h);

    connection.control('stream.open', { resume: 'live' });

    const frame = h.written().replace('retry: 2500\n\n', '');
    expect(frame).toBe('event: stream.open\ndata: {"resume":"live"}\n\n');
    expect(frame).not.toContain('id:');
  });

  it('writes a comment for a heartbeat, on the interval, with no event attached', () => {
    jest.useFakeTimers();
    const h = harness();
    h.drain();
    open(h, { heartbeatIntervalMs: 1000, now: () => new Date('2026-01-02T03:04:05.000Z') });

    expect(h.written()).not.toContain(':  heartbeat');
    jest.advanceTimersByTime(2500);

    const beats = h.written().match(/^: heartbeat /gm) ?? [];
    expect(beats).toHaveLength(2);
    expect(h.written()).toContain(': heartbeat 2026-01-02T03:04:05.000Z\n\n');
  });

  it('does not hold the process open on the heartbeat alone', () => {
    // An open socket already keeps the loop alive; the timer should not
    // additionally keep a process running that has nothing left to serve. The
    // assertion is on the handle rather than on a call to `unref`, because what
    // matters is the state it leaves the timer in.
    const started: NodeJS.Timeout[] = [];
    const real = global.setInterval;
    const spy = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(((...args: Parameters<typeof setInterval>) => {
        const timer = real(...args);
        started.push(timer);
        return timer;
      }) as typeof setInterval);

    const h = harness();
    h.drain();
    const connection = open(h);
    spy.mockRestore();

    expect(started).toHaveLength(1);
    expect(started[0]?.hasRef()).toBe(false);
    connection.close('client');
  });
});

describe('openSseConnection: closing', () => {
  it('reports the reason to every listener, exactly once', () => {
    const h = harness();
    h.drain();
    const connection = open(h);
    const seen: SseCloseReason[] = [];
    connection.onClose((reason) => seen.push(reason));

    connection.close('server-shutdown');
    connection.close('client');

    expect(seen).toEqual(['server-shutdown']);
    expect(connection.closed).toBe(true);
  });

  it('runs the listeners after a failing one rather than abandoning them', () => {
    // The listener most likely to be skipped is the hub's unsubscribe, and
    // skipping it leaves a closed connection being written to for the life of
    // the process.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness();
    h.drain();
    const connection = open(h);
    const reached = jest.fn();

    connection.onClose(() => {
      throw new Error('subscriber blew up');
    });
    connection.onClose(reached);
    connection.close('client');

    expect(reached).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('closes when the client goes away, without anything asking it to', async () => {
    const h = harness();
    h.drain();
    const connection = open(h);
    const seen: SseCloseReason[] = [];
    connection.onClose((reason) => seen.push(reason));

    h.res.destroy();
    // The stream's `close` is emitted on the next tick, which is also true of a
    // real socket: a disconnect is observed asynchronously, so a fan-out is
    // always capable of writing to a connection whose peer has already gone.
    // That write is why `write` catches rather than trusting the flag.
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual(['client']);
    expect(connection.closed).toBe(true);
  });

  it('survives a write to a connection whose peer has already gone', () => {
    const h = harness();
    h.drain();
    const connection = open(h);
    h.res.destroy();

    // Synchronously after the destroy, before `close` has been emitted: the
    // flag is still false and the write lands on a destroyed stream.
    expect(() => connection.send(message('run:1', 'tick', '{}'))).not.toThrow();
  });

  it('stops the heartbeat when it closes', () => {
    jest.useFakeTimers();
    const h = harness();
    h.drain();
    const connection = open(h);

    connection.close('client');
    const after = h.written();
    jest.advanceTimersByTime(60_000);

    expect(h.written()).toBe(after);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores every write after it has closed', () => {
    const h = harness();
    h.drain();
    const connection = open(h);
    connection.close('client');
    const after = h.written();

    connection.send(message('run:1', 'tick', '{}'));
    connection.control('stream.open', {});
    connection.comment('still here');

    expect(h.written()).toBe(after);
  });
});

describe('openSseConnection: backpressure', () => {
  /**
   * The failure being escaped: `res.write()` to a peer that has stopped reading
   * neither blocks nor fails, it buffers in this process without bound. One
   * stalled subscriber therefore accumulates every event the service publishes.
   *
   * Note that nothing here reads from `h.res` — that is the stalled client.
   */
  it('drops a connection whose buffer passes the ceiling', () => {
    const h = harness();
    const connection = open(h, { maxBufferedBytes: 64 });
    const seen: SseCloseReason[] = [];
    connection.onClose((reason) => seen.push(reason));

    const payload = JSON.stringify({ blob: 'x'.repeat(200) });
    for (let i = 0; i < 20 && !connection.closed; i += 1) {
      connection.send(message(`run:${i}`, 'tick', payload));
    }

    expect(connection.closed).toBe(true);
    expect(seen).toEqual(['slow-consumer']);
  });

  it('destroys rather than ends, so the FIN does not queue behind the backlog', () => {
    const h = harness();
    const connection = open(h, { maxBufferedBytes: 64 });

    const payload = JSON.stringify({ blob: 'x'.repeat(200) });
    for (let i = 0; i < 20 && !connection.closed; i += 1) {
      connection.send(message(`run:${i}`, 'tick', payload));
    }

    expect(h.res.destroyed).toBe(true);
  });

  it('leaves a client that is keeping up alone', () => {
    // `write()` returning false is the ordinary state of a socket mid-burst and
    // is deliberately not the trigger; only a buffer staying above the much
    // larger ceiling is.
    const h = harness();
    h.drain();
    const connection = open(h, { maxBufferedBytes: 64 });

    for (let i = 0; i < 50; i += 1) {
      connection.send(message(`run:${i}`, 'tick', '{"n":1}'));
    }

    expect(connection.closed).toBe(false);
  });
});
