import { createSseHub, STREAM_OPEN_EVENT } from '@/sse/hub';
import type { SseHub, StreamOpenPayload } from '@/sse/hub';
import type { SseCloseReason, SseConnection } from '@/sse/connection';
import type { StreamMessage } from '@/sse/event-log';

const STREAM = 'testrun';

/**
 * A connection recorded rather than written.
 *
 * The hub deals only in `SseConnection`, so a fan-out to two hundred sockets is
 * testable without one — which is the reason the transport was split out of
 * this module in the first place.
 */
interface FakeConnection extends SseConnection {
  readonly frames: { event: string; id?: string; data: string }[];
  /** Closes as if the peer had gone away, running the hub's own listener. */
  disconnect(reason?: SseCloseReason): void;
  /** Everything after the `stream.open` control frame. */
  events(): StreamMessage[];
  open(): StreamOpenPayload;
}

function fakeConnection(): FakeConnection {
  const frames: { event: string; id?: string; data: string }[] = [];
  const listeners: ((reason: SseCloseReason) => void)[] = [];
  let closed = false;

  const close = (reason: SseCloseReason): void => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener(reason);
  };

  return {
    frames,
    get closed(): boolean {
      return closed;
    },
    send(message) {
      if (closed) return;
      frames.push({ event: message.event, id: message.id, data: message.data });
    },
    control(event, payload) {
      if (closed) return;
      frames.push({ event, data: JSON.stringify(payload) });
    },
    comment() {
      /* comments are not observable to a client and nothing here asserts on them */
    },
    close,
    onClose(listener) {
      listeners.push(listener);
    },
    disconnect(reason = 'client') {
      close(reason);
    },
    events() {
      return frames
        .filter((f) => f.event !== STREAM_OPEN_EVENT)
        .map((f) => ({ id: f.id ?? '', event: f.event, data: f.data }));
    },
    open() {
      const frame = frames.find((f) => f.event === STREAM_OPEN_EVENT);
      if (frame === undefined) throw new Error('no stream.open frame was sent');
      return JSON.parse(frame.data) as StreamOpenPayload;
    },
  };
}

function hubOf(overrides: Partial<Parameters<typeof createSseHub>[0]> = {}): SseHub {
  return createSseHub({
    replayBufferSize: 8,
    maxConnections: 4,
    streamId: STREAM,
    ...overrides,
  });
}

describe('createSseHub', () => {
  it.each([0, -1, 2.5])('rejects a maxConnections of %p', (maxConnections) => {
    expect(() => hubOf({ maxConnections })).toThrow(RangeError);
  });

  it('exposes the stream id its ids are minted under', () => {
    expect(hubOf().streamId).toBe(STREAM);
  });
});

describe('SseHub.publish', () => {
  it('writes one event to every open stream', () => {
    const hub = hubOf();
    const a = fakeConnection();
    const b = fakeConnection();
    hub.attach(a, undefined);
    hub.attach(b, undefined);

    hub.publish('user.created', { userId: 'u1' });

    expect(a.events()).toEqual([
      { id: `${STREAM}:1`, event: 'user.created', data: '{"userId":"u1"}' },
    ]);
    expect(b.events()).toEqual(a.events());
  });

  it('serialises the payload once, so a publisher cannot edit what a replay delivers', () => {
    const hub = hubOf();
    const payload = { userId: 'u1' };
    hub.publish('seed', {});
    const message = hub.publish('user.created', payload);

    payload.userId = 'tampered';

    const late = fakeConnection();
    hub.attach(late, `${STREAM}:1`);
    expect(message.data).toBe('{"userId":"u1"}');
    expect(late.events()[0]?.data).toBe('{"userId":"u1"}');
  });

  it('publishes with no subscribers, and the events are still there to replay', () => {
    const hub = hubOf();
    hub.publish('tick', { n: 1 });
    hub.publish('tick', { n: 2 });

    const late = fakeConnection();
    hub.attach(late, `${STREAM}:1`);

    expect(late.open()).toEqual({ streamId: STREAM, resume: 'replayed', replayed: 1 });
    expect(late.events().map((e) => e.data)).toEqual(['{"n":2}']);
  });

  it('skips a connection that closed mid fan-out', () => {
    const hub = hubOf();
    const a = fakeConnection();
    const b = fakeConnection();
    hub.attach(a, undefined);
    hub.attach(b, undefined);
    b.disconnect();

    expect(() => hub.publish('tick', { n: 1 })).not.toThrow();
    expect(a.events()).toHaveLength(1);
    expect(b.events()).toHaveLength(0);
    expect(hub.connectionCount).toBe(1);
  });
});

describe('SseHub.attach', () => {
  it('announces a fresh stream as live, before anything else', () => {
    const hub = hubOf();
    const connection = fakeConnection();

    hub.attach(connection, undefined);

    expect(connection.frames[0]?.event).toBe(STREAM_OPEN_EVENT);
    expect(connection.open()).toEqual({ streamId: STREAM, resume: 'live', replayed: 0 });
  });

  it('announces the resume before the replay it describes, not after', () => {
    // A client has to know whether what follows is history or news *before* it
    // arrives; told afterwards it has already applied the frames.
    const hub = hubOf();
    for (let i = 1; i <= 3; i += 1) hub.publish('tick', { n: i });

    const connection = fakeConnection();
    hub.attach(connection, `${STREAM}:1`);

    expect(connection.frames.map((f) => f.event)).toEqual([STREAM_OPEN_EVENT, 'tick', 'tick']);
    expect(connection.open()).toEqual({ streamId: STREAM, resume: 'replayed', replayed: 2 });
  });

  it('tells a client with an unusable cursor to re-read state, and keeps the stream', () => {
    // Not a 4xx: the connection is fine and the only thing wrong is the
    // assumption that the client's view is still incrementally reachable.
    // Refusing the request would take away the means of recovering from that.
    const hub = hubOf({ replayBufferSize: 2 });
    for (let i = 1; i <= 5; i += 1) hub.publish('tick', { n: i });

    const connection = fakeConnection();
    hub.attach(connection, `${STREAM}:1`);

    expect(connection.open()).toEqual({
      streamId: STREAM,
      resume: 'reset',
      replayed: 0,
      reason: 'expired',
    });
    expect(connection.closed).toBe(false);

    hub.publish('tick', { n: 6 });
    expect(connection.events().map((e) => e.data)).toEqual(['{"n":6}']);
  });

  it('reports a cursor from another run as a reset rather than replaying a stranger', () => {
    const hub = hubOf();
    hub.publish('tick', { n: 1 });

    const connection = fakeConnection();
    hub.attach(connection, 'otherrun:1');

    expect(connection.open().reason).toBe('unknown-stream');
  });

  it('joins the live set with no suspension point after reading the replay', async () => {
    // The resume race, stated as a test: an event published between the replay
    // read and the join would be delivered by neither. It cannot happen while
    // `attach` is synchronous, which is what this asserts — the publish is
    // scheduled ahead of the attach and still lands after it.
    const hub = hubOf();
    hub.publish('tick', { n: 1 });
    const connection = fakeConnection();

    const published = Promise.resolve().then(() => hub.publish('tick', { n: 2 }));
    hub.attach(connection, `${STREAM}:1`);
    await published;

    expect(connection.events().map((e) => e.data)).toEqual(['{"n":2}']);
  });

  it('forgets a connection when it closes', () => {
    const hub = hubOf();
    const connection = fakeConnection();
    hub.attach(connection, undefined);
    expect(hub.connectionCount).toBe(1);

    connection.disconnect();

    expect(hub.connectionCount).toBe(0);
  });

  it('does not add a connection that died during its own replay', () => {
    // A replay large enough to trip the slow-consumer ceiling closes the
    // connection inside `attach`. Added afterwards it would sit in the set for
    // the life of the process, holding a slot against `maxConnections`.
    const hub = hubOf();
    for (let i = 1; i <= 3; i += 1) hub.publish('tick', { n: i });

    const connection = fakeConnection();
    const original = connection.send.bind(connection);
    let sent = 0;
    connection.send = (message): void => {
      original(message);
      if (++sent === 1) connection.disconnect('slow-consumer');
    };

    hub.attach(connection, `${STREAM}:1`);

    expect(connection.closed).toBe(true);
    expect(hub.connectionCount).toBe(0);
  });
});

describe('SseHub capacity', () => {
  it('reports capacity until the ceiling and not past it', () => {
    const hub = hubOf({ maxConnections: 2 });
    expect(hub.hasCapacity()).toBe(true);

    hub.attach(fakeConnection(), undefined);
    expect(hub.hasCapacity()).toBe(true);

    const last = fakeConnection();
    hub.attach(last, undefined);
    expect(hub.hasCapacity()).toBe(false);

    last.disconnect();
    expect(hub.hasCapacity()).toBe(true);
  });

  it('publishes the ceiling so a 503 can name it', () => {
    expect(hubOf({ maxConnections: 7 }).maxConnections).toBe(7);
  });
});

describe('SseHub.closeAll', () => {
  it('ends every stream and empties the set', () => {
    const hub = hubOf();
    const connections = [fakeConnection(), fakeConnection(), fakeConnection()];
    const reasons: SseCloseReason[] = [];
    for (const connection of connections) {
      connection.onClose((reason) => reasons.push(reason));
      hub.attach(connection, undefined);
    }

    hub.closeAll();

    expect(reasons).toEqual(['server-shutdown', 'server-shutdown', 'server-shutdown']);
    expect(hub.connectionCount).toBe(0);
  });

  it('is safe to call twice', () => {
    const hub = hubOf();
    hub.attach(fakeConnection(), undefined);
    hub.closeAll();
    expect(() => hub.closeAll()).not.toThrow();
  });
});
