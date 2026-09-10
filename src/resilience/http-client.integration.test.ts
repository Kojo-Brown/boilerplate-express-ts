import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { CircuitOpenError } from '@/resilience/circuit-breaker';
import { createHttpClient } from '@/resilience/http-client';
import type { HttpClientOptions } from '@/resilience/http-client';

/**
 * The cases a scripted `fetch` cannot answer, against a real origin on an
 * ephemeral port and the real global `fetch`.
 *
 * `http-client.test.ts` covers the decisions — what is retried, what counts
 * against the breaker, what the ladder waits. What is left needs a socket:
 * whether the retry reuses the connection, whether an open circuit really costs
 * the caller nothing, and whether a deadline set on a request that never
 * arrives produces the failure the breaker is counting on. Each of these has
 * passed against a mock in some codebase while being false in production.
 */

interface Origin {
  readonly url: string;
  /** Requests the server received. */
  readonly requests: () => number;
  /** TCP connections it accepted — the measurement the drain claim rests on. */
  readonly connections: () => number;
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, requestIndex: number) => void;

async function startOrigin(handler: Handler): Promise<Origin> {
  let requests = 0;
  let connections = 0;
  const open = new Set<http.ServerResponse>();
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const index = requests;
    requests += 1;
    open.add(res);
    res.on('close', () => open.delete(res));
    handler(req, res, index);
  });
  server.on('connection', (socket: Socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    connections: () => connections,
    close: async () => {
      // A handler that never answered is holding a socket the server would
      // otherwise wait on forever, which is a hung suite rather than a failed
      // assertion.
      for (const res of open) res.destroy();
      // And every socket, answered or not: `server.close` waits on connections
      // the client is keeping alive, which is several seconds of idle teardown
      // per case in a suite that has otherwise finished.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      });
    },
  };
}

/**
 * Polls until `condition` holds, or gives up after `timeoutMs`.
 *
 * For the assertions about something the *origin* observes, where the fact
 * being asserted is that it happens at all. A fixed sleep long enough to be
 * safe on a loaded CI runner is time every green run pays; one short enough to
 * be quick is a flake waiting for a bad afternoon.
 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A client on the real transport, with the backoff and the jitter pinned. */
function client(url: string, options: Partial<HttpClientOptions> = {}) {
  return createHttpClient({
    name: 'origin',
    baseUrl: url,
    // The ladder is asserted in the unit suite; spending it here would only
    // make this file slow.
    sleep: async () => {},
    random: () => 0,
    breaker: { minimumThroughput: 3, failureRateThreshold: 0.5, openJitterRatio: 0 },
    ...options,
  });
}

describe('createHttpClient against a real origin', () => {
  let origin: Origin | undefined;

  afterEach(async () => {
    await origin?.close();
    origin = undefined;
  });

  it('reuses the connection across retries instead of re-handshaking', async () => {
    // The measurement behind `drainForRetry`. Three attempts at a large error
    // body, taken three ways against this same origin: reading the discarded
    // body stayed on 2 connections, ignoring it cost 3, and `body.cancel()` —
    // the line this is usually written as — cost 4, because cancelling destroys
    // a connection with a half-read response on it and then opens a
    // replacement. At the moment a dependency is failing, that is a fresh TCP
    // and TLS handshake per retry, paid by the service least able to afford it.
    // Below about 64 KiB all three are identical, which is why this stays
    // invisible until an origin starts returning a real error page.
    //
    // Asserted as "fewer connections than requests" rather than as the exact 2:
    // the pool's own decisions are not this module's contract, but the
    // difference between reuse and none is.
    //
    // The body is deliberately under the `drainBytes` set below. Past the cap
    // the client stops reading and cancels — correctly, since the alternative
    // is an unbounded read — and this case would then be measuring the
    // `cancel` column rather than the `consume` one.
    const errorBody = 'x'.repeat(200 * 1024);
    origin = await startOrigin((_req, res, index) => {
      if (index < 2) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end(errorBody);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });

    const response = await client(origin.url, {
      retry: { drainBytes: 256 * 1024 },
    }).fetch('/charges');

    await expect(response.text()).resolves.toBe('ok');
    expect(origin.requests()).toBe(3);
    expect(origin.connections()).toBeLessThan(origin.requests());
  });

  it('costs the caller nothing once the circuit is open', async () => {
    origin = await startOrigin((_req, res) => {
      res.writeHead(500).end('down');
    });

    const http = client(origin.url, {
      retry: { attempts: 3 },
      breaker: { minimumThroughput: 3, failureRateThreshold: 0.5, openMs: 30_000, openJitterRatio: 0 },
    });

    await http.fetch('/charges');
    expect(http.breaker.state).toBe('open');
    const requestsWhenOpened = origin.requests();

    await expect(http.fetch('/charges')).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(http.fetch('/charges')).rejects.toBeInstanceOf(CircuitOpenError);

    // Not "it threw quickly" but "the origin never heard from us": no socket,
    // no request, nothing for the failing dependency to answer.
    expect(origin.requests()).toBe(requestsWhenOpened);
  });

  it('turns a request that is never answered into a retryable failure', async () => {
    // The failure mode a breaker most needs and a mock never produces: an
    // origin that accepts the connection and then says nothing. Without a
    // deadline the attempt never completes, so nothing is recorded, the ladder
    // is never reached, and the caller's socket is held indefinitely.
    origin = await startOrigin((_req, res, index) => {
      if (index === 0) return; // Accepted, never answered.
      res.writeHead(200).end('ok');
    });

    const http = client(origin.url, { timeoutMs: 150, retry: { attempts: 2 } });
    const response = await http.fetch('/charges');

    expect(response.status).toBe(200);
    expect(origin.requests()).toBe(2);
    expect(http.breaker.stats()).toMatchObject({ failures: 1, successes: 1 });
  });

  it('gives up on a hung origin rather than waiting for it', async () => {
    origin = await startOrigin(() => {
      // Every attempt hangs.
    });

    const http = client(origin.url, { timeoutMs: 100, retry: { attempts: 2 } });

    await expect(http.fetch('/charges')).rejects.toThrow();
    expect(origin.requests()).toBe(2);
    expect(http.breaker.stats().failures).toBe(2);
  });

  it('reads a real origin’s Retry-After off the wire', async () => {
    const waits: number[] = [];
    origin = await startOrigin((_req, res, index) => {
      if (index === 0) {
        res.writeHead(429, { 'retry-after': '3', 'content-type': 'text/plain' });
        res.end('slow down');
        return;
      }
      res.writeHead(200).end('ok');
    });

    const http = client(origin.url, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      retry: { attempts: 2, baseDelayMs: 100 },
    });

    const response = await http.fetch('/charges');

    expect(response.status).toBe(200);
    // Three seconds from the origin; the jitter on top is drawn from
    // `[0, baseDelayMs)` with `random: () => 0` pinned to its floor.
    expect(waits).toEqual([3_000]);
  });

  it('writes off a silent origin on the headers budget, not the whole one', async () => {
    // The distinction the coarse deadline cannot draw. `timeoutMs` has to be
    // sized for the largest legitimate exchange; a dependency that accepts the
    // connection and then says nothing is held for all of it. The headers
    // deadline covers no body, so it can be set to what a healthy answer really
    // costs — and the caller is released in that instead.
    origin = await startOrigin(() => {
      // Accepted, never answered.
    });

    const http = client(origin.url, {
      timeoutMs: 5_000,
      headersTimeoutMs: 150,
      retry: { attempts: 1 },
    });

    const started = Date.now();
    await expect(http.fetch('/charges')).rejects.toMatchObject({
      name: 'DependencyTimeoutError',
      phase: 'headers',
      statusCode: 504,
    });

    // Not "it eventually failed" but "it failed on the budget it was given":
    // the whole-exchange deadline is 5s away and must not be what fired.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(http.breaker.stats()).toMatchObject({ failures: 1 });
  });

  it('retries a headers timeout like any other transport failure', async () => {
    origin = await startOrigin((_req, res, index) => {
      if (index === 0) return; // Accepted, never answered.
      res.writeHead(200).end('ok');
    });

    const http = client(origin.url, {
      timeoutMs: 5_000,
      headersTimeoutMs: 150,
      retry: { attempts: 2 },
    });

    await expect(http.fetch('/charges')).resolves.toMatchObject({ status: 200 });
    expect(origin.requests()).toBe(2);
    expect(http.breaker.stats()).toMatchObject({ failures: 1, successes: 1 });
  });

  it('fails a body that stops mid-transfer, and lets the socket go', async () => {
    // The failure an overall deadline handles worst and a mock cannot produce:
    // an origin that answers, sends part of a body, and stops. With a 5s
    // exchange budget sized for a real download, this caller waits 5s for a
    // stream that will never produce another byte.
    let responseClosed = false;
    origin = await startOrigin((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first chunk');
      res.on('close', () => {
        responseClosed = true;
      });
      // And then nothing.
    });

    const http = client(origin.url, {
      timeoutMs: 5_000,
      bodyIdleTimeoutMs: 150,
      retry: { attempts: 1 },
    });

    // The headers arrived, so the call itself succeeded — which is exactly why
    // the breaker cannot be the thing that catches this.
    const response = await http.fetch('/charges');
    expect(response.status).toBe(200);

    await expect(response.text()).rejects.toMatchObject({
      name: 'DependencyTimeoutError',
      phase: 'body',
      statusCode: 504,
    });

    // The claim that makes this a socket timeout rather than a stream
    // decoration: the origin sees the connection go, so it stops holding a
    // response open for a reader that has given up.
    //
    // Polled rather than slept on a fixed margin. The assertion is that the
    // close *happens*, not that it happens within some number of milliseconds
    // of a loaded runner's scheduling, and a single `setTimeout` long enough to
    // be safe there is a second this suite spends on every green run.
    await waitFor(() => responseClosed);
    expect(responseClosed).toBe(true);
  });

  it('holds a slow body open for as long as it keeps producing', async () => {
    // The other half of the previous case, and the reason an idle deadline is
    // the right instrument: a body that takes far longer than the idle budget
    // in total is fine, so long as it never goes quiet for that long at once.
    origin = await startOrigin((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      let sent = 0;
      const tick = setInterval(() => {
        sent += 1;
        res.write('chunk');
        if (sent === 5) {
          clearInterval(tick);
          res.end();
        }
      }, 100);
    });

    const http = client(origin.url, { timeoutMs: 5_000, bodyIdleTimeoutMs: 400 });
    const response = await http.fetch('/export');

    // Five chunks 100ms apart is 500ms of transfer against a 400ms idle budget,
    // so a deadline measuring *duration* would fail this and one measuring
    // silence does not. The 300ms of headroom between the chunk interval and
    // the budget is deliberate: a margin this test can lose to a loaded runner
    // scheduling one `setInterval` late is a flake, not a measurement.
    await expect(response.text()).resolves.toBe('chunk'.repeat(5));
  });

  it('keeps concurrent sockets to a dependency under the bulkhead cap', async () => {
    // Asserted at the origin rather than at our own counter, because the claim
    // is about what the dependency experiences: a cap that were merely
    // bookkeeping on this side would pass a unit test and open six connections.
    let concurrent = 0;
    let peak = 0;

    origin = await startOrigin((_req, res) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      res.on('close', () => {
        concurrent -= 1;
      });
      // Slow enough that six unbounded callers would overlap unmistakably, and
      // fast enough that three waves of two are still a quick test.
      setTimeout(() => res.writeHead(200).end('ok'), 60);
    });

    const dependency = client(origin.url, {
      bulkhead: { maxConcurrent: 2, maxQueue: 10, queueTimeoutMs: 5_000 },
      retry: { attempts: 1 },
    });

    const calls = Array.from({ length: 6 }, () => dependency.fetch('/charges'));
    await expect(Promise.all(calls)).resolves.toHaveLength(6);

    // Every call was made — the bulkhead delays work, it does not drop it while
    // there is queue left — and never more than two of them at once.
    expect(origin.requests()).toBe(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('does not retry a POST the origin has already acted on', async () => {
    origin = await startOrigin((_req, res) => {
      res.writeHead(503).end('try later');
    });

    const response = await client(origin.url).fetch('/charges', {
      method: 'POST',
      body: JSON.stringify({ amount: 1000 }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(503);
    expect(origin.requests()).toBe(1);
  });
});
