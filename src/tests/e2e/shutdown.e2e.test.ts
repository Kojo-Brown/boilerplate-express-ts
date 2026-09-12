import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApp } from '@/app';
import { closePool } from '@/db/pool';
import {
  appLifecycle,
  createGracefulShutdown,
  trackHttpServer,
} from '@/shutdown';
import type { ShutdownPhase } from '@/shutdown';

/**
 * The whole sequence against a real socket, which is the only way to observe
 * any of it.
 *
 * `supertest` opens a connection per request and closes it, so a suite written
 * with it cannot see the case this exists for — a client holding a keep-alive
 * socket open across the signal — and cannot see a listener close either,
 * because it never had one. So: a real port, a real client with a connection
 * pool, and a request that is deliberately still running when `SIGTERM` lands.
 *
 * The process-wide `appLifecycle` is what the app's guard and health route read,
 * and this file drives it to `closed`. That is one-way, which is why the whole
 * story is one test rather than several sharing a server that each of them would
 * have to leave in a state the next one could use.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Client {
  get(path: string): Promise<{ status: number; body: string; connection: string | undefined }>;
  destroy(): void;
}

function keepAliveClient(port: number): Client {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  return {
    get(path: string) {
      return new Promise((resolve, reject) => {
        // `host` explicitly, matching the bind address: left to default the
        // client asks for `localhost`, which on a dual-stack machine is both
        // `::1` and `127.0.0.1`, and a connection failure then arrives as an
        // `AggregateError` rather than as the error itself.
        const req = http.get({ host: '127.0.0.1', port, path, agent }, (res: IncomingMessage) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection });
          });
        });
        req.on('error', reject);
      });
    },
    destroy(): void {
      agent.destroy();
    },
  };
}

/**
 * Every error code behind a failed connection, flattened.
 *
 * A hostname that resolves to more than one address makes Node try each and
 * report the collected failures as an `AggregateError` whose own message is the
 * empty string — so this asks the codes rather than matching a message, which is
 * a `/ECONNREFUSED/` assertion that passes locally and fails on a dual-stack CI
 * runner with nothing in the output to say why.
 */
function connectionErrorCodes(error: unknown): readonly string[] {
  if (error instanceof AggregateError) {
    return (error.errors as unknown[]).flatMap(connectionErrorCodes);
  }

  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === undefined ? [] : [code];
}

/** Asserts that a request found no listener at all. */
async function expectConnectionRefused(request: Promise<unknown>): Promise<void> {
  const error = await request.then(
    () => {
      throw new Error('expected the connection to be refused, but the request was answered');
    },
    (reason: unknown) => reason,
  );

  expect(connectionErrorCodes(error)).toContain('ECONNREFUSED');
}

function json(body: string): { data: unknown; error: { code: string } | null } {
  return JSON.parse(body) as { data: unknown; error: { code: string } | null };
}

describe('graceful shutdown', () => {
  let server: Server;
  let client: Client;
  let probe: Client;

  /** Held open until the test releases it, standing in for a slow route. */
  const held: ServerResponse[] = [];
  const drainWindow = deferred<void>();
  let poolClosed = false;

  afterAll(() => {
    client.destroy();
    probe.destroy();
  });

  it('drains without cutting off the request that was in flight', async () => {
    // The real app, with one route in front of it whose response this test owns.
    // Mounted ahead of the app rather than inside it because `createApp` ends in
    // a 404 handler, and anything added afterwards is unreachable.
    const outer = express();
    outer.get('/held', (_req, res) => {
      held.push(res);
    });
    outer.use(createApp());

    server = http.createServer(outer);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    client = keepAliveClient(port);
    probe = keepAliveClient(port);

    const httpDrain = trackHttpServer(server);

    // The same phases `server.ts` installs, with two substitutions: the drain
    // window is a promise this test resolves rather than a timer it would have
    // to out-run, and the pool close records that it happened. Everything about
    // the ordering under test is unchanged.
    const phases: readonly ShutdownPhase[] = [
      {
        name: 'unready',
        tasks: [{ name: 'load-balancer-drain', run: () => drainWindow.promise }],
      },
      {
        name: 'in-flight',
        tasks: [
          {
            name: 'http-server',
            run: async (signal) => {
              appLifecycle.beginClosing();
              await httpDrain.drain({ signal });
            },
          },
        ],
      },
      {
        name: 'resources',
        tasks: [
          {
            name: 'postgres-pool',
            run: async () => {
              await closePool();
              poolClosed = true;
            },
          },
        ],
      },
    ];

    const shutdown = createGracefulShutdown({
      lifecycle: appLifecycle,
      phases,
      timeoutMs: 5_000,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      exit: () => {},
    });

    // --- before the signal -------------------------------------------------
    const ready = await probe.get('/v1/health');
    expect(ready.status).toBe(200);
    expect(json(ready.body).data).toMatchObject({ status: 'ok' });

    // A request that will still be running when the signal arrives. This is the
    // one the whole sequence exists to protect.
    const inFlight = client.get('/held');
    await waitFor(() => held.length === 1);

    // --- the signal --------------------------------------------------------
    const shuttingDown = shutdown.shutdown('SIGTERM');

    // Unready immediately, before anything has closed. This is what a load
    // balancer polls, and it is the only thing that changes during the window.
    const draining = await probe.get('/v1/health');
    expect(draining.status).toBe(503);
    expect(json(draining.body).error?.code).toBe('SERVER_DRAINING');

    // ...while ordinary routing is completely unaffected. Refusing here would
    // fail traffic the balancer has not stopped sending yet, which is the damage
    // the window exists to avoid.
    const routed = await probe.get('/v1/does-not-exist');
    expect(routed.status).toBe(404);
    expect(json(routed.body).error?.code).toBe('NOT_FOUND');

    expect(server.listening).toBe(true);
    expect(poolClosed).toBe(false);

    // --- the balancer has noticed; close the listener ----------------------
    drainWindow.resolve();
    await waitFor(() => !server.listening);

    // Closed to new connections, and still holding the request from before.
    await expectConnectionRefused(probe.get('/v1/health'));
    // The ordering that matters most: the pool is still open, because something
    // is still using it.
    expect(poolClosed).toBe(false);
    expect(httpDrain.inFlight).toBe(1);

    // --- let the in-flight request finish ----------------------------------
    held[0]?.end('finished');

    const response = await inFlight;
    expect(response.status).toBe(200);
    // Whole, not truncated. A drain that produced a partial body here would be
    // a `SIGKILL` with extra steps.
    expect(response.body).toBe('finished');
    // And told not to reuse the socket, which is what lets the drain end at all.
    expect(response.connection).toBe('close');

    const report = await shuttingDown;

    expect(report.outcome).toBe('clean');
    expect(report.tasks.map((task) => `${task.task}=${task.outcome}`)).toEqual([
      'load-balancer-drain=completed',
      'http-server=completed',
      'postgres-pool=completed',
    ]);
    expect(poolClosed).toBe(true);
    expect(appLifecycle.state).toBe('closed');
  });
});

/** Polls until `predicate` holds, or fails the test by timing out. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
