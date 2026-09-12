import http from 'node:http';
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { trackHttpServer } from '@/shutdown/http-drain';

/**
 * Every assertion here is about a *keep-alive* socket, so the client has to be
 * one that keeps sockets alive. `fetch` and `supertest` both open a connection
 * per request and close it, which is the one case `server.close()` already
 * handles by itself — a suite written with either would pass against a drain
 * that does nothing at all.
 */
interface Client {
  get(path: string): Promise<{ status: number; body: string; connection: string | undefined }>;
  destroy(): void;
}

function keepAliveClient(port: number): Client {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  return {
    get(path: string) {
      return new Promise((resolve, reject) => {
        // `host` explicitly, matching the bind address. Left to default, the
        // client asks for `localhost`, which on a dual-stack machine is both
        // `::1` and `127.0.0.1` — and a failure to reach either then arrives as
        // an `AggregateError` rather than the connection error itself.
        const req = http.get({ host: '127.0.0.1', port, path, agent }, (res: IncomingMessage) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body,
              connection: res.headers.connection,
            });
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

interface Harness {
  readonly server: Server;
  readonly client: Client;
  close(): Promise<void>;
}

async function listen(handler: RequestListener): Promise<Harness> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const client = keepAliveClient(port);

  return {
    server,
    client,
    async close(): Promise<void> {
      client.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * Every error code behind a failed connection, flattened.
 *
 * `AggregateError` is the reason this is not a message match: when a hostname
 * resolves to more than one address, Node tries each and reports the collected
 * failures as an `AggregateError` whose own message is the empty string. A
 * dual-stack CI runner therefore fails a `/ECONNREFUSED/` assertion that passes
 * on a machine with no IPv6 loopback, with nothing in the output to say why.
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

/** Resolves to `'timed out'` if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timed out'> {
  return Promise.race([
    promise,
    new Promise<'timed out'>((resolve) => {
      const timer = setTimeout(() => {
        resolve('timed out');
      }, ms);
      timer.unref();
    }),
  ]);
}

/** A handler whose responses are released by the test rather than by a timer. */
function gatedHandler(): {
  handler: RequestListener;
  release(body: string): void;
  received: () => number;
} {
  const pending: ServerResponse[] = [];

  return {
    handler: (_req, res) => {
      pending.push(res);
    },
    release(body: string): void {
      for (const res of pending.splice(0)) res.end(body);
    },
    received: () => pending.length,
  };
}

describe('trackHttpServer', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  it('closes a server with nothing in flight', async () => {
    harness = await listen((_req, res) => {
      res.end('ok');
    });
    const drain = trackHttpServer(harness.server);

    const report = await within(drain.drain(), 1_000);

    expect(report).toMatchObject({ outcome: 'drained', wasListening: true, inFlightAtStart: 0 });
    expect(harness.server.listening).toBe(false);
  });

  it('finishes an in-flight request and then stops waiting on its keep-alive socket', async () => {
    // The regression this module exists for. Without the `Connection: close`
    // the drain sets, the response below completes exactly as it does here, the
    // socket goes back to idle keep-alive, and `server.close()` never calls back
    // — the process sits there until SIGKILL takes the rest of the requests with
    // it. Measured, not assumed: with the header suppressed, this response still
    // arrives in full and `draining` below is still unsettled a second later.
    const gate = gatedHandler();
    harness = await listen(gate.handler);
    const drain = trackHttpServer(harness.server);

    const inFlight = harness.client.get('/slow');
    await waitFor(() => gate.received() === 1);

    const draining = drain.drain();
    expect(drain.inFlight).toBe(1);

    gate.release('finished');

    const response = await inFlight;
    expect(response.status).toBe(200);
    // The whole body, not a truncated one: the request was finished, not cut off.
    expect(response.body).toBe('finished');
    expect(response.connection).toBe('close');

    const report = await within(draining, 1_000);
    expect(report).toMatchObject({ outcome: 'drained', inFlightAtStart: 1, forcedConnections: 0 });
  });

  it('ends the connection of a request that arrives mid-drain', async () => {
    const gate = gatedHandler();
    harness = await listen(gate.handler);
    const drain = trackHttpServer(harness.server);

    // One exchange holds the drain open, so a second request can be sent down a
    // socket the listener has already stopped accepting new ones on.
    const first = harness.client.get('/first');
    await waitFor(() => gate.received() === 1);
    const draining = drain.drain();

    gate.release('first');
    await first;

    // A fresh connection is refused outright once the listener is closed, so the
    // case this covers is the one that is reachable: the client's pooled socket.
    // It was ended with the first response, which is the behaviour under test —
    // the request below therefore opens a new connection and is refused.
    await expectConnectionRefused(harness.client.get('/second'));
    expect(await within(draining, 1_000)).toMatchObject({ outcome: 'drained' });
  });

  it('destroys what is left when the deadline arrives, and says how much', async () => {
    const gate = gatedHandler();
    harness = await listen(gate.handler);
    const drain = trackHttpServer(harness.server);

    // Never released: a handler that does not come back is exactly what the
    // deadline is for.
    const abandoned = harness.client.get('/never');
    abandoned.catch(() => undefined);
    await waitFor(() => gate.received() === 1);

    const report = await within(drain.drain({ timeoutMs: 50 }), 2_000);

    expect(report).toMatchObject({ outcome: 'forced', inFlightAtStart: 1 });
    expect((report as { forcedConnections: number }).forcedConnections).toBeGreaterThan(0);
    await expect(abandoned).rejects.toThrow();
  });

  it('forces on an aborted signal, so one budget can govern the whole sequence', async () => {
    const gate = gatedHandler();
    harness = await listen(gate.handler);
    const drain = trackHttpServer(harness.server);

    const abandoned = harness.client.get('/never');
    abandoned.catch(() => undefined);
    await waitFor(() => gate.received() === 1);

    const budget = new AbortController();
    const draining = drain.drain({ signal: budget.signal });
    // Still waiting: the signal is the only clock, and it has not fired.
    expect(await within(draining, 100)).toBe('timed out');

    budget.abort();

    expect(await within(draining, 2_000)).toMatchObject({ outcome: 'forced' });
  });

  it('returns the same report for a second drain instead of closing twice', async () => {
    harness = await listen((_req, res) => {
      res.end('ok');
    });
    const drain = trackHttpServer(harness.server);

    // A second `server.close()` would register its callback on a `close` event
    // that has already been emitted, and never hear from it again.
    const [first, second] = await Promise.all([
      within(drain.drain(), 1_000),
      within(drain.drain(), 1_000),
    ]);

    expect(second).toBe(first);
  });

  it('drains a server that was never listening', async () => {
    const server = http.createServer((_req, res) => {
      res.end('ok');
    });
    const drain = trackHttpServer(server);

    const report = await within(drain.drain(), 1_000);

    expect(report).toMatchObject({ outcome: 'drained', wasListening: false });
  });

  it('ends the socket of a response whose headers had already gone out', async () => {
    // A streaming response has no header left to set, so the connection is
    // closed after the body instead. The client still reads every byte.
    const chunks: ServerResponse[] = [];
    harness = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first ');
      chunks.push(res);
    });
    const drain = trackHttpServer(harness.server);

    const streaming = harness.client.get('/stream');
    await waitFor(() => chunks.length === 1);

    const draining = drain.drain();
    chunks[0]?.end('second');

    const response = await streaming;
    expect(response.body).toBe('first second');
    expect(await within(draining, 1_000)).toMatchObject({ outcome: 'drained' });
  });

  it('stops counting an exchange whose client hung up', async () => {
    const gate = gatedHandler();
    harness = await listen(gate.handler);
    const drain = trackHttpServer(harness.server);

    const abandoned = harness.client.get('/aborted');
    abandoned.catch(() => undefined);
    await waitFor(() => gate.received() === 1);
    expect(drain.inFlight).toBe(1);

    // `close` and not `finish` on the response is what makes this work: a
    // dropped connection never finishes, and counting it would leave the drain
    // waiting on work that no longer has anyone to deliver to.
    harness.client.destroy();
    await waitFor(() => drain.inFlight === 0);

    expect(await within(drain.drain(), 1_000)).toMatchObject({ outcome: 'drained' });
  });
});

/** Polls until `predicate` holds, or fails the test by timing out. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
