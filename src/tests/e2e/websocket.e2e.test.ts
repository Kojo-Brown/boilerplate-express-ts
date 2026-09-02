import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import WebSocket from 'ws';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';
import { BEARER_SUBPROTOCOL } from '@/ws/handshake';
import { WS_CLOSE } from '@/ws/ws.close';
import { attachWebSocketServer } from '@/ws/ws.server';
import type { WsServerHandle, WsServerOptions } from '@/ws/ws.server';
import { handleClientFrame } from '@/ws/ws.protocol';
import type { ServerFrame } from '@/ws/ws.protocol';

/**
 * The endpoint against a real socket, because most of what this module claims
 * is only true of one.
 *
 * The unit tests reach every rule through a fake socket, which is the right
 * place for them — a fake is the only way to stage a peer that stops reading or
 * one that never answers a ping. What a fake cannot show is the part that lives
 * below the application: whether an unauthenticated upgrade actually produces
 * an HTTP response a client can read, whether the negotiated subprotocol comes
 * back in a form a real client accepts, and whether a close code survives the
 * wire. Those are this file.
 *
 * The server is built here rather than taken from `server.ts` for the same
 * reason the SSE suite builds its own app: the process-wide one reads `env`,
 * and a suite that wanted a 2-connection ceiling would otherwise have to open
 * a thousand sockets to reach it.
 */

const app = createApp();

const WS_PATH = '/v1/ws';

let server: Server;
let wsHandle: WsServerHandle;
let baseUrl: string;
let token: string;

/** Default bounds: small, so a case can reach a limit in a few frames. */
const defaultOptions: Omit<WsServerOptions, 'onMessage'> = {
  path: WS_PATH,
  maxConnections: 4,
  maxPayloadBytes: 1024,
  heartbeatIntervalMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
  allowedOrigins: ['https://app.example.test'],
  rateLimit: {
    burst: 5,
    messagesPerSecond: 5,
    bytesPerSecond: 4096,
    maxMessageBytes: 1024,
  },
};

/**
 * Rebuilds the endpoint with different bounds, on the same HTTP server.
 *
 * Detaching the previous handle first matters: `attachWebSocketServer`
 * registers an `upgrade` listener and Node calls every one of them, so a suite
 * that stacked handles would have two servers racing to answer the same
 * handshake.
 */
async function reattach(overrides: Partial<WsServerOptions> = {}): Promise<void> {
  await wsHandle.close();
  wsHandle = attachWebSocketServer(server, {
    ...defaultOptions,
    onMessage: handleClientFrame,
    ...overrides,
  });
}

interface Client {
  readonly socket: WebSocket;
  readonly frames: ServerFrame[];
  /** Resolves once `count` frames have arrived, or throws on timeout. */
  waitForFrames(count: number): Promise<ServerFrame[]>;
  /** Resolves with the close code and reason once the socket closes. */
  waitForClose(): Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
  close(): void;
}

/** Opens a socket and resolves once it is open, or rejects with the handshake failure. */
function connect(
  options: {
    token?: string | null;
    via?: 'header' | 'subprotocol';
    origin?: string;
    path?: string;
  } = {},
): Promise<Client> {
  const { token: credential = token, via = 'header', origin, path = WS_PATH } = options;

  const headers: Record<string, string> = {};
  if (origin !== undefined) headers['origin'] = origin;
  if (via === 'header' && credential !== null) headers['authorization'] = `Bearer ${credential}`;

  const protocols =
    via === 'subprotocol' && credential !== null ? [BEARER_SUBPROTOCOL, credential] : undefined;

  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}${path}`, protocols, { headers });

  const frames: ServerFrame[] = [];
  const framesArrived: (() => void)[] = [];
  let closed: { code: number; reason: string } | undefined;
  const closeWaiters: ((value: { code: number; reason: string }) => void)[] = [];

  socket.on('message', (data: Buffer) => {
    frames.push(JSON.parse(data.toString('utf8')) as ServerFrame);
    for (const notify of framesArrived.splice(0)) notify();
  });

  socket.on('close', (code: number, reason: Buffer) => {
    closed = { code, reason: reason.toString('utf8') };
    for (const resolve of closeWaiters.splice(0)) resolve(closed);
  });

  const client: Client = {
    socket,
    frames,
    async waitForFrames(count: number): Promise<ServerFrame[]> {
      const deadline = Date.now() + 5_000;
      while (frames.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} frame(s); saw ${JSON.stringify(frames)}`);
        }
        await new Promise<void>((resolve) => {
          framesArrived.push(resolve);
          setTimeout(resolve, 25);
        });
      }
      return frames;
    },
    waitForClose(): Promise<{ code: number; reason: string }> {
      if (closed !== undefined) return Promise.resolve(closed);
      return new Promise((resolve, reject) => {
        closeWaiters.push(resolve);
        setTimeout(() => reject(new Error('timed out waiting for close')), 5_000).unref();
      });
    },
    send(frame: unknown): void {
      socket.send(JSON.stringify(frame));
    },
    close(): void {
      socket.close();
    },
  };

  return new Promise<Client>((resolve, reject) => {
    socket.once('open', () => resolve(client));
    // `ws` reports a refused handshake as an `error` carrying the status it
    // read, which is the only way a client learns why — hence `refusal` below
    // reading the body over plain HTTP instead.
    socket.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
    socket.once('error', (err: Error) => reject(err));
  });
}

/**
 * Performs the upgrade as a plain HTTP request and returns the refusal.
 *
 * A `WebSocket` client throws away the response body of a failed handshake, so
 * the assertion that a refusal is a *readable JSON error* — the whole reason
 * this module owns the `upgrade` event instead of using `verifyClient` — has to
 * be made against the raw request.
 */
function refusal(headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    // `http.request` rather than `fetch`: `Connection` and `Upgrade` are
    // forbidden header names in the fetch spec, so undici strips them and the
    // server never sees an upgrade at all.
    const req = httpRequest(
      `${baseUrl}${WS_PATH}`,
      {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );

    // A refusal that reached `handleUpgrade` instead of `refuseUpgrade` would
    // arrive here rather than as a response, which is a failure worth naming.
    req.on('upgrade', () => reject(new Error('handshake was accepted, expected a refusal')));
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  // A bare `http.Server` with the app as its request handler, so the upgrade
  // and the REST routes are served by one listener — which is the arrangement
  // `server.ts` uses and the one the endpoint has to work under.
  server = createServer(app);
  wsHandle = attachWebSocketServer(server, { ...defaultOptions, onMessage: handleClientFrame });

  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await resetRateLimiters();
  const login = await request(app).post('/v1/auth/login').send({
    email: 'admin@example.com',
    password: 'password',
  });
  token = (login.body as { data: { accessToken: string } }).data.accessToken;
});

afterEach(async () => {
  await reattach();
});

afterAll(async () => {
  await wsHandle.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

describe('WebSocket handshake', () => {
  it('accepts a valid access token in the Authorization header', async () => {
    const client = await connect();
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('accepts a token offered through the bearer subprotocol, and echoes the sentinel', async () => {
    const client = await connect({ via: 'subprotocol' });

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    // The negotiated protocol is the sentinel. If the server echoed the token,
    // a live credential would be sitting in a response header.
    expect(client.socket.protocol).toBe(BEARER_SUBPROTOCOL);
    expect(client.socket.protocol).not.toContain(token);

    client.close();
  });

  it('refuses an anonymous upgrade with a readable JSON error', async () => {
    // The reason this module owns the `upgrade` event: `verifyClient` can
    // refuse a handshake but cannot say anything a client can read.
    const result = await refusal({});

    expect(result.status).toBe(401);
    expect(result.body).toEqual({
      data: null,
      meta: null,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining(BEARER_SUBPROTOCOL) },
    });
  });

  it('refuses a forged token with 401', async () => {
    const result = await refusal({ authorization: 'Bearer not.a.real.token' });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
  });

  it('refuses a disallowed browser origin with 403', async () => {
    const result = await refusal({
      authorization: `Bearer ${token}`,
      origin: 'https://evil.example.test',
    });

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
  });

  it('accepts the allowed origin', async () => {
    const client = await connect({ origin: 'https://app.example.test' });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('refuses an upgrade to a path it does not serve, rather than leaking the socket', async () => {
    // Returning without touching the socket would hang the client and, worse,
    // make `server.close()` wait on it forever — Node only destroys an
    // unhandled upgrade when there is no listener at all.
    await expect(connect({ path: '/v1/not-the-socket' })).rejects.toThrow(/404/);
  });

  it('leaves the REST routes on the same server working', async () => {
    // The endpoint is an `upgrade` listener, not a route — an ordinary GET to
    // the same path and port must still reach Express.
    const response = await fetch(`${baseUrl}/v1/health`);
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe('WebSocket capacity', () => {
  it('refuses an upgrade past the connection ceiling with 503', async () => {
    await reattach({ maxConnections: 2 });

    const first = await connect();
    const second = await connect();
    expect(wsHandle.connectionCount).toBe(2);

    const result = await refusal({ authorization: `Bearer ${token}` });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: 'WS_CAPACITY_EXHAUSTED' } });

    first.close();
    second.close();
  });

  it('frees the slot when a client disconnects', async () => {
    await reattach({ maxConnections: 1 });

    const first = await connect();
    expect(wsHandle.connectionCount).toBe(1);

    first.close();
    await waitForConnectionCount(0);

    const second = await connect();
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    second.close();
  });
});

describe('WebSocket protocol', () => {
  it('answers a ping with a correlated pong', async () => {
    const client = await connect();
    client.send({ type: 'ping', id: 'req-1' });

    const [frame] = await client.waitForFrames(1);
    expect(frame).toEqual({ type: 'pong', id: 'req-1' });

    client.close();
  });

  it('carries the handshake principal onto the socket', async () => {
    const client = await connect();
    client.send({ type: 'whoami' });

    const [frame] = await client.waitForFrames(1);
    expect(frame).toMatchObject({ type: 'whoami', roles: expect.arrayContaining(['admin']) });

    client.close();
  });

  it('answers a malformed frame without closing the connection', async () => {
    const client = await connect();
    client.socket.send('{not json');

    const [frame] = await client.waitForFrames(1);
    expect(frame).toMatchObject({ type: 'error', code: 'MALFORMED_FRAME' });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    client.close();
  });
});

describe('WebSocket per-connection rate limits', () => {
  it('closes a connection that exceeds its message budget, with 4008 and a reason', async () => {
    await reattach({
      rateLimit: { burst: 3, messagesPerSecond: 3, bytesPerSecond: 4096, maxMessageBytes: 1024 },
    });

    const client = await connect();
    for (let i = 0; i < 10; i += 1) client.send({ type: 'ping', id: `req-${i}` });

    const { code, reason } = await client.waitForClose();
    expect(code).toBe(WS_CLOSE.RATE_LIMITED);
    expect(reason).toContain('rate limit exceeded');
  });

  it('limits each connection separately, so one noisy client does not close another', async () => {
    // The property that makes this a *per-connection* limit rather than a
    // global one: a shared bucket would take both of these down together.
    await reattach({
      rateLimit: { burst: 3, messagesPerSecond: 3, bytesPerSecond: 4096, maxMessageBytes: 1024 },
    });

    const noisy = await connect();
    const quiet = await connect();

    for (let i = 0; i < 10; i += 1) noisy.send({ type: 'ping', id: `n-${i}` });
    await noisy.waitForClose();

    quiet.send({ type: 'ping', id: 'q-1' });
    const [frame] = await quiet.waitForFrames(1);
    expect(frame).toEqual({ type: 'pong', id: 'q-1' });
    expect(quiet.socket.readyState).toBe(WebSocket.OPEN);

    quiet.close();
  });

  it('closes a connection sending a frame above its size ceiling', async () => {
    await reattach({
      rateLimit: { burst: 5, messagesPerSecond: 5, bytesPerSecond: 65_536, maxMessageBytes: 64 },
    });

    const client = await connect();
    client.send({ type: 'echo', payload: 'a'.repeat(200) });

    const { code, reason } = await client.waitForClose();
    expect(code).toBe(WS_CLOSE.RATE_LIMITED);
    expect(reason).toContain('exceeds the 64-byte limit');
  });

  it('refuses a frame above maxPayload during reassembly, before any handler runs', async () => {
    // The bound the application cannot enforce: by the time `onMessage` runs,
    // `ws` has already buffered the whole frame. 1009 is `ws` itself refusing.
    await reattach({ maxPayloadBytes: 128 });

    const client = await connect();
    client.socket.send('a'.repeat(4096));

    const { code } = await client.waitForClose();
    expect(code).toBe(WS_CLOSE.MESSAGE_TOO_BIG);
  });

  it('admits again after the bucket refills', async () => {
    await reattach({
      // 20/s refills a token every 50ms, so the wait below is a fifth of a
      // second rather than a flaky one.
      rateLimit: { burst: 2, messagesPerSecond: 20, bytesPerSecond: 65_536, maxMessageBytes: 1024 },
    });

    const client = await connect();
    client.send({ type: 'ping', id: 'a' });
    client.send({ type: 'ping', id: 'b' });
    await client.waitForFrames(2);

    await new Promise((resolve) => setTimeout(resolve, 200));

    client.send({ type: 'ping', id: 'c' });
    const frames = await client.waitForFrames(3);
    expect(frames[2]).toEqual({ type: 'pong', id: 'c' });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    client.close();
  });
});

describe('WebSocket shutdown', () => {
  it('closes open sockets with 1001 rather than letting them hang a graceful stop', async () => {
    const client = await connect();
    const closing = client.waitForClose();

    await wsHandle.close();

    const { code, reason } = await closing;
    expect(code).toBe(WS_CLOSE.GOING_AWAY);
    expect(reason).toBe('Server shutting down');
  });

  it('stops accepting upgrades once closed', async () => {
    await wsHandle.close();
    await expect(connect()).rejects.toThrow();
  });
});

describe('token expiry', () => {
  it('closes the socket with 4001 when the presented token expires', async () => {
    // A two-second token, so the wait is real rather than mocked: this is the
    // one property that separates socket auth from request auth, and it is
    // worth seeing a live socket close on its own.
    const twoSecondToken = signWithExpiry(Math.floor(Date.now() / 1000) + 2);

    const client = await connect({ token: twoSecondToken });
    const { code, reason } = await client.waitForClose();

    expect(code).toBe(WS_CLOSE.TOKEN_EXPIRED);
    expect(reason).toContain('refresh');
  }, 10_000);
});

/**
 * Mints an access token with a chosen `exp`.
 *
 * `signAccessToken` only produces one with the configured lifetime, and a
 * fifteen-minute wait is not a test.
 */
function signWithExpiry(exp: number): string {
  return jwt.sign({ userId: 'admin-1', roles: ['admin'], type: 'access', exp }, env.JWT_ACCESS_SECRET);
}

async function waitForConnectionCount(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (wsHandle.connectionCount !== expected) {
    if (Date.now() > deadline) {
      throw new Error(
        `server still holds ${wsHandle.connectionCount} connection(s), expected ${expected}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
