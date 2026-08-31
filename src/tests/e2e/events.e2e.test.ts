import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '@/app';
import { domainEventBus } from '@/events';
import { domainEventStreamHub } from '@/sse/events.hub';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';
import { STREAM_OPEN_EVENT } from '@/sse/hub';
import type { StreamOpenPayload } from '@/sse/hub';

// env vars are set in jest.setup.ts — including a 150ms heartbeat, so a real
// one can be observed here rather than a scheduled timer being asserted.

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

/**
 * The whole route against a real socket, and it has to be a real one.
 *
 * `supertest` buffers a response and resolves when it ends, which is exactly
 * what this endpoint never does — every assertion here is about bytes arriving
 * *while* the response is open. So the app is bound to an ephemeral port and
 * read incrementally with `fetch`, which is also the client shape the route's
 * bearer auth forces on a browser (see `sse.router.ts`).
 */
const app = createApp();

let server: Server;
let baseUrl: string;
let adminToken: string;
let userToken: string;

interface Frame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

interface StreamClient {
  readonly status: number;
  readonly headers: Headers;
  readonly frames: Frame[];
  /** Resolves once `count` frames matching `where` have arrived. */
  waitFor(count: number, where?: (frame: Frame) => boolean): Promise<Frame[]>;
  close(): void;
}

/** One `\n\n`-terminated block, as the client's own parser would read it. */
function parseBlock(block: string): Frame {
  const frame: { id?: string; event?: string; data?: string; comment?: string } = {};
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trimStart();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') frame.id = value;
    else if (field === 'event') frame.event = value;
    else if (field === 'data') data.push(value);
  }

  if (data.length > 0) frame.data = data.join('\n');
  return frame;
}

async function openStream(
  token: string,
  options: { lastEventId?: string; query?: string } = {},
): Promise<StreamClient> {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'text/event-stream',
  };
  if (options.lastEventId !== undefined) headers['last-event-id'] = options.lastEventId;

  const response = await fetch(`${baseUrl}/v1/events/stream${options.query ?? ''}`, {
    headers,
    signal: controller.signal,
  });

  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];

  if (response.body !== null && response.status === 200) {
    void (async (): Promise<void> => {
      let buffer = '';
      try {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          buffer += Buffer.from(chunk).toString('utf8');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            frames.push(parseBlock(buffer.slice(0, boundary)));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
          }
          for (const notify of waiters.splice(0)) notify();
        }
      } catch {
        // The abort that ends the stream lands here. Nothing to report: closing
        // the client is how every case in this file finishes.
      }
    })();
  } else {
    await response.text();
  }

  return {
    status: response.status,
    headers: response.headers,
    frames,
    async waitFor(count, where = (): boolean => true): Promise<Frame[]> {
      const deadline = Date.now() + 5000;
      for (;;) {
        const matched = frames.filter(where);
        if (matched.length >= count) return matched;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${count} frame(s); saw ${JSON.stringify(frames)}`,
          );
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 25);
        });
      }
    },
    close(): void {
      controller.abort();
    },
  };
}

/** Publishes a domain event and returns the SSE id it was recorded under. */
async function publishUserDeleted(userId: string): Promise<void> {
  await domainEventBus.publish('user.deleted', { userId, actorId: 'admin-1' });
}

async function token(email: string): Promise<string> {
  await resetRateLimiters();
  const res = await request(app)
    .post('/v1/auth/login')
    .send({ email, password: 'password' });
  return (res.body as { data: { accessToken: string } }).data.accessToken;
}

/** Waits for the hub to notice a disconnect, which arrives on the socket's own schedule. */
async function waitForConnectionCount(expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (domainEventStreamHub.connectionCount !== expected) {
    if (Date.now() > deadline) {
      throw new Error(
        `hub still holds ${domainEventStreamHub.connectionCount} connection(s), expected ${expected}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const openPayload = (frames: Frame[]): StreamOpenPayload =>
  JSON.parse(frames.find((f) => f.event === STREAM_OPEN_EVENT)?.data ?? '{}') as StreamOpenPayload;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminToken = await token('admin@example.com');
  userToken = await token('user@example.com');
});

afterEach(async () => {
  domainEventStreamHub.closeAll();
  await waitForConnectionCount(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('GET /v1/events/stream — access', () => {
  it('refuses an anonymous caller before any stream is opened', async () => {
    const response = await fetch(`${baseUrl}/v1/events/stream`);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    await response.text();
  });

  it('refuses a non-admin, since the payloads are the audit log delivered live', async () => {
    const stream = await openStream(userToken);
    expect(stream.status).toBe(403);
  });
});

describe('GET /v1/events/stream — opening', () => {
  it('answers 200 with the headers an event stream needs', async () => {
    const stream = await openStream(adminToken);

    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');

    stream.close();
  });

  it('announces a fresh stream as live before anything is published', async () => {
    const stream = await openStream(adminToken);

    const [open] = await stream.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);
    expect(JSON.parse(open?.data ?? '{}')).toEqual({
      streamId: domainEventStreamHub.streamId,
      resume: 'live',
      replayed: 0,
    });
    // A control frame carries no id, so it does not move the client's cursor
    // onto a position the replay log has no event for.
    expect(open?.id).toBeUndefined();

    stream.close();
  });

  it('delivers a domain event published while it is open', async () => {
    const stream = await openStream(adminToken);
    await stream.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);

    await publishUserDeleted('u-live');

    const [frame] = await stream.waitFor(1, (f) => f.event === 'user.deleted');
    expect(JSON.parse(frame?.data ?? '{}')).toMatchObject({
      correlationId: null,
      payload: { userId: 'u-live', actorId: 'admin-1' },
    });
    expect(frame?.id).toMatch(/^[0-9a-f]{16}:\d+$/);

    stream.close();
  });

  it('writes a heartbeat comment to an idle stream', async () => {
    // Two things go wrong without it and neither announces itself: a proxy
    // closes a connection that has carried no bytes, and a peer that vanished
    // without a FIN holds its slot forever because nothing writes to it.
    const stream = await openStream(adminToken);

    const beats = await stream.waitFor(2, (f) => f.comment?.startsWith('heartbeat') === true);
    expect(beats).toHaveLength(2);
    // A comment dispatches nothing: no event, no data, no cursor movement.
    expect(beats[0]).toEqual({ comment: expect.stringMatching(/^heartbeat \d{4}-/) as unknown });

    stream.close();
  });

  it('releases the slot when the client goes away', async () => {
    const stream = await openStream(adminToken);
    await stream.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);
    expect(domainEventStreamHub.connectionCount).toBe(1);

    stream.close();

    await waitForConnectionCount(0);
  });
});

describe('GET /v1/events/stream — Last-Event-ID resume', () => {
  it('replays exactly what was published while the client was away', async () => {
    const first = await openStream(adminToken);
    await first.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);
    await publishUserDeleted('u-1');
    const [seen] = await first.waitFor(1, (f) => f.event === 'user.deleted');
    const cursor = seen?.id;
    first.close();
    await waitForConnectionCount(0);

    // The gap: published with nobody listening.
    await publishUserDeleted('u-2');
    await publishUserDeleted('u-3');

    const resumed = await openStream(adminToken, { lastEventId: cursor ?? '' });
    const replayed = await resumed.waitFor(2, (f) => f.event === 'user.deleted');

    expect(openPayload(resumed.frames)).toEqual({
      streamId: domainEventStreamHub.streamId,
      resume: 'replayed',
      replayed: 2,
    });
    expect(replayed.map((f) => JSON.parse(f.data ?? '{}').payload.userId)).toEqual(['u-2', 'u-3']);
    // And still live afterwards, not merely a history dump.
    await publishUserDeleted('u-4');
    await resumed.waitFor(3, (f) => f.event === 'user.deleted');

    resumed.close();
  });

  it('accepts the cursor in the query string, which is all a page reload has', async () => {
    // `EventSource` cannot be given a request header, so a client that
    // persisted its cursor across a reload has only the URL to present it in.
    const first = await openStream(adminToken);
    await first.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);
    await publishUserDeleted('q-1');
    const [seen] = await first.waitFor(1, (f) => f.event === 'user.deleted');
    first.close();
    await waitForConnectionCount(0);

    await publishUserDeleted('q-2');

    const resumed = await openStream(adminToken, {
      query: `?lastEventId=${encodeURIComponent(seen?.id ?? '')}`,
    });
    const replayed = await resumed.waitFor(1, (f) => f.event === 'user.deleted');

    expect(openPayload(resumed.frames).resume).toBe('replayed');
    expect(JSON.parse(replayed[0]?.data ?? '{}').payload.userId).toBe('q-2');

    resumed.close();
  });

  it('tells a client whose cursor fell off the buffer to re-read state, and keeps serving it', async () => {
    const first = await openStream(adminToken);
    await first.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);
    await publishUserDeleted('e-0');
    const [seen] = await first.waitFor(1, (f) => f.event === 'user.deleted');
    first.close();
    await waitForConnectionCount(0);

    // `SSE_REPLAY_BUFFER_SIZE` is 8 under test; ten more evicts the cursor.
    for (let i = 1; i <= 10; i += 1) await publishUserDeleted(`e-${i}`);

    const resumed = await openStream(adminToken, { lastEventId: seen?.id ?? '' });
    await resumed.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);

    expect(openPayload(resumed.frames)).toEqual({
      streamId: domainEventStreamHub.streamId,
      resume: 'reset',
      replayed: 0,
      reason: 'expired',
    });
    // A reset is not a refusal — the stream stays open, which is what makes it
    // recoverable at all.
    await publishUserDeleted('e-after');
    const [live] = await resumed.waitFor(1, (f) => f.event === 'user.deleted');
    expect(JSON.parse(live?.data ?? '{}').payload.userId).toBe('e-after');

    resumed.close();
  });

  it.each([
    ['a cursor from another run of the process', 'ffffffffffffffff:2', 'unknown-stream'],
    ['a cursor that is not a cursor', 'nonsense', 'malformed'],
  ])('resets on %s', async (_label, lastEventId, reason) => {
    const stream = await openStream(adminToken, { lastEventId });
    await stream.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);

    expect(openPayload(stream.frames)).toMatchObject({ resume: 'reset', reason });

    stream.close();
  });

  it('is live for a client that already holds the latest event', async () => {
    const stream = await openStream(adminToken);
    await stream.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);
    await publishUserDeleted('caught-up');
    const [seen] = await stream.waitFor(1, (f) => f.event === 'user.deleted');
    stream.close();
    await waitForConnectionCount(0);

    const resumed = await openStream(adminToken, { lastEventId: seen?.id ?? '' });
    await resumed.waitFor(1, (f) => f.event === STREAM_OPEN_EVENT);

    expect(openPayload(resumed.frames)).toMatchObject({ resume: 'live', replayed: 0 });

    resumed.close();
  });
});
