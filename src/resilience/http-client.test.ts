import { CircuitOpenError } from '@/resilience/circuit-breaker';
import {
  classifyResponse,
  createHttpClient,
  isRetryableTransportError,
} from '@/resilience/http-client';
import type { FetchLike, HttpClientOptions, RetryNotice } from '@/resilience/http-client';

interface Harness {
  readonly client: ReturnType<typeof createHttpClient>;
  /** One entry per `fetch` the client actually made. */
  readonly calls: { url: string; init: RequestInit | undefined }[];
  /** One entry per backoff the client asked for, in milliseconds. */
  readonly delays: number[];
  readonly notices: RetryNotice[];
}

/**
 * A client whose every source of non-determinism is pinned: the transport is a
 * script, the clock does not move, the jitter draws 0.5 and the backoff is
 * recorded rather than slept. Nothing in this file waits for a real delay.
 */
function harness(
  script: (Response | Error | ((init: RequestInit | undefined) => Response | Error))[],
  options: Partial<HttpClientOptions> = {},
): Harness {
  const calls: Harness['calls'] = [];
  const delays: number[] = [];
  const notices: RetryNotice[] = [];

  const doFetch: FetchLike = (input, init) => {
    const step = script[calls.length];
    calls.push({ url: String(input), init });
    if (step === undefined) throw new Error(`unscripted fetch #${calls.length}`);
    const resolved = typeof step === 'function' ? step(init) : step;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const client = createHttpClient({
    name: 'payments',
    fetch: doFetch,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    now: () => Date.parse('2026-03-01T12:00:00.000Z'),
    onRetry: (notice) => notices.push(notice),
    // Small enough that a handful of failures trips it, and honest about the
    // floor: one call's own ladder must not be able to open a circuit.
    breaker: { minimumThroughput: 3, failureRateThreshold: 0.5, openJitterRatio: 0 },
    ...options,
  });

  return { client, calls, delays, notices };
}

/** undici's shape for a real network fault: a `TypeError` wrapping a `cause`. */
function transportFailure(message = 'fetch failed'): TypeError {
  const err = new TypeError(message);
  Object.defineProperty(err, 'cause', { value: new Error('ECONNRESET'), enumerable: false });
  return err;
}

function body(status: number, headers: Record<string, string> = {}): Response {
  return new Response('the origin said something', { status, headers });
}

describe('classifyResponse', () => {
  it.each([
    [200, false, false],
    [301, false, false],
    [400, false, false],
    [401, false, false],
    [404, false, false],
    [409, false, false],
    [422, false, false],
    [408, true, true],
    [429, true, true],
    [500, true, true],
    [502, true, true],
    [503, true, true],
    [504, true, true],
  ])('reads %i as failure=%s retryable=%s', (status, dependencyFailure, retryable) => {
    expect(classifyResponse(status)).toEqual({ dependencyFailure, retryable });
  });

  it('treats 501 as a permanent answer rather than a sick server', () => {
    // The endpoint does not exist and will not start existing. Retrying burns
    // the ladder to arrive at the same sentence, and counting it against the
    // dependency's health would open a circuit in front of a service that is up.
    expect(classifyResponse(501)).toEqual({ dependencyFailure: false, retryable: false });
  });

  it('does not let a caller with a bad request open a circuit', () => {
    // The distinction the whole classification exists for: a 404 is a correct
    // answer from a healthy dependency. Counting 4xx would let one caller's
    // wrong URL shut the dependency off for every other caller.
    expect(classifyResponse(404).dependencyFailure).toBe(false);
  });
});

describe('isRetryableTransportError', () => {
  it('retries a network fault', () => {
    expect(isRetryableTransportError(transportFailure())).toBe(true);
  });

  it('does not retry a bare TypeError, which is a bug in the call', () => {
    // undici raises `TypeError: fetch failed` with the real fault in `cause`
    // for a network error; a `TypeError` with nothing underneath is an invalid
    // URL or an unsupported option, and it will be exactly as invalid next time.
    expect(isRetryableTransportError(new TypeError('Invalid URL'))).toBe(false);
  });
});

describe('createHttpClient', () => {
  describe('the happy path', () => {
    it('makes one call and returns the response', async () => {
      const { client, calls, delays } = harness([body(200)]);

      const response = await client.fetch('https://payments.test/charges');

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(delays).toEqual([]);
    });

    it('resolves a path against the client’s base URL', async () => {
      const { client, calls } = harness([body(200)], { baseUrl: 'https://payments.test/v2/' });

      await client.fetch('charges');

      expect(calls[0]?.url).toBe('https://payments.test/v2/charges');
    });

    it('hands the caller a body nothing has touched', async () => {
      const { client } = harness([body(200)]);

      const response = await client.fetch('https://payments.test/charges');

      expect(response.bodyUsed).toBe(false);
      await expect(response.text()).resolves.toBe('the origin said something');
    });
  });

  describe('retrying', () => {
    it('repeats a 503 and returns the attempt that worked', async () => {
      const { client, calls } = harness([body(503), body(503), body(200)]);

      const response = await client.fetch('https://payments.test/charges');

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(3);
    });

    it('climbs the full-jitter ladder between attempts', async () => {
      const { client, delays } = harness([body(500), body(500), body(500)], {
        retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
      });

      await client.fetch('https://payments.test/charges');

      // `random: () => 0.5` draws the midpoint of a window that doubles per
      // attempt: [0,100) then [0,200).
      expect(delays).toEqual([50, 100]);
    });

    it('stops at the attempt budget and returns the last failure', async () => {
      const { client, calls } = harness([body(500), body(500)], { retry: { attempts: 2 } });

      const response = await client.fetch('https://payments.test/charges');

      expect(response.status).toBe(500);
      expect(calls).toHaveLength(2);
    });

    it('does not retry at all when the policy says one attempt', async () => {
      const { client, calls } = harness([body(503)], { retry: { attempts: 1 } });

      await client.fetch('https://payments.test/charges');

      expect(calls).toHaveLength(1);
    });

    it('returns a 404 without asking again', async () => {
      const { client, calls } = harness([body(404)]);

      const response = await client.fetch('https://payments.test/charges/missing');

      expect(response.status).toBe(404);
      expect(calls).toHaveLength(1);
    });

    it('repeats a network fault', async () => {
      const { client, calls } = harness([transportFailure(), body(200)]);

      await expect(client.fetch('https://payments.test/charges')).resolves.toMatchObject({
        status: 200,
      });
      expect(calls).toHaveLength(2);
    });

    it('rethrows a network fault that outlasts the budget', async () => {
      const { client } = harness([transportFailure(), transportFailure()], {
        retry: { attempts: 2 },
      });

      await expect(client.fetch('https://payments.test/charges')).rejects.toThrow('fetch failed');
    });

    it('does not repeat a bug in the calling code', async () => {
      const { client, calls } = harness([new TypeError('Invalid URL')]);

      await expect(client.fetch('https://payments.test/charges')).rejects.toThrow('Invalid URL');
      expect(calls).toHaveLength(1);
    });

    it('reports each retry to the caller’s hook', async () => {
      const { client, notices } = harness([body(503), body(200)]);

      await client.fetch('https://payments.test/charges');

      expect(notices).toEqual([
        {
          client: 'payments',
          attempt: 1,
          delayMs: 50,
          reason: 'status',
          status: 503,
          honouredRetryAfter: false,
        },
      ]);
    });
  });

  describe('what may be replayed', () => {
    it('refuses to repeat a POST, whatever the failure', async () => {
      const { client, calls } = harness([body(503)]);

      const response = await client.fetch('https://payments.test/charges', { method: 'POST' });

      // A retry after an ambiguous failure charges the card twice, and a socket
      // reset cannot be told apart from a lost response to a request that
      // succeeded.
      expect(response.status).toBe(503);
      expect(calls).toHaveLength(1);
    });

    it('repeats a POST that carries an Idempotency-Key', async () => {
      const { client, calls } = harness([body(503), body(200)]);

      const response = await client.fetch('https://payments.test/charges', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'mock-idempotency-key-0001' },
      });

      // The key is the caller's own statement that a duplicate will be
      // absorbed — the same contract this service offers through
      // `@/idempotency` — which is what makes the replay safe without guessing.
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
    });

    it('repeats a POST when the caller opts in explicitly', async () => {
      const { client, calls } = harness([body(503), body(200)]);

      await client.fetch('https://payments.test/charges', {
        method: 'POST',
        retry: { retryNonIdempotent: true },
      });

      expect(calls).toHaveLength(2);
    });

    it('repeats a PUT without being asked', async () => {
      const { client, calls } = harness([body(503), body(200)]);

      await client.fetch('https://payments.test/charges/1', { method: 'PUT' });

      expect(calls).toHaveLength(2);
    });

    it('refuses to repeat a request whose body is a stream', async () => {
      const { client, calls } = harness([body(503)]);

      const response = await client.fetch('https://payments.test/charges/1', {
        method: 'PUT',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
          },
        }),
        duplex: 'half',
      } as never);

      // The method says replayable and the body says otherwise. The second
      // attempt would send an empty body and the origin would answer a
      // truncated request with a 400 that looks like the caller's fault —
      // silent in every other respect, which is why it is detected rather than
      // documented.
      expect(response.status).toBe(503);
      expect(calls).toHaveLength(1);
    });
  });

  describe('Retry-After', () => {
    it('waits as long as the origin asked, plus jitter', async () => {
      const { client, delays, notices } = harness([body(429, { 'Retry-After': '2' }), body(200)], {
        retry: { baseDelayMs: 100 },
      });

      await client.fetch('https://payments.test/charges');

      // Every client that got this response received the same number, so
      // honouring it exactly would re-synchronise all of them onto one instant
      // — the herd the header was sent to prevent. The jitter is added on top
      // rather than replacing it: 2000ms + the midpoint of [0,100).
      expect(delays).toEqual([2_050]);
      expect(notices[0]?.honouredRetryAfter).toBe(true);
    });

    it('falls back to its own ladder when the header is malformed', async () => {
      const { client, delays, notices } = harness([body(503, { 'Retry-After': 'soon' }), body(200)]);

      await client.fetch('https://payments.test/charges');

      expect(delays).toEqual([50]);
      expect(notices[0]?.honouredRetryAfter).toBe(false);
    });

    it('hands back the response rather than waiting out a long one', async () => {
      const { client, calls, delays } = harness([body(503, { 'Retry-After': '600' })], {
        retry: { maxRetryAfterMs: 20_000 },
      });

      const response = await client.fetch('https://payments.test/charges');

      // Ten minutes is an outage, not a blip. Holding an inbound request open
      // to honour it converts one dependency's problem into exhausted capacity
      // here; returning the answer lets the caller degrade now, with the header
      // intact for it to act on.
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('600');
      expect(calls).toHaveLength(1);
      expect(delays).toEqual([]);
    });
  });

  describe('bodies of responses it is about to discard', () => {
    it('reads a retried body so the connection can be reused', async () => {
      const discarded = body(503);
      const { client } = harness([discarded, body(200)]);

      await client.fetch('https://payments.test/charges');

      // The line usually written as `response.body?.cancel()`. Cancelling
      // destroys a connection with a half-read response on it, so the retry
      // pays a fresh handshake at the moment the dependency can least afford
      // one; `http-client.integration.test.ts` measures the difference.
      expect(discarded.bodyUsed).toBe(true);
    });

    it('gives up on the connection rather than read an unbounded error page', async () => {
      let pulls = 0;
      let cancelled = false;
      const huge = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1_024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      );

      const { client } = harness([huge, body(200)], { retry: { drainBytes: 4_096 } });
      await client.fetch('https://payments.test/charges');

      // The cap is what stops "consume it" from being an unbounded read of
      // whatever an angry proxy decided to send. Past it the connection is the
      // price, and the stream that would never end is let go.
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThanOrEqual(6);
    });
  });

  describe('the circuit breaker', () => {
    it('stops calling a dependency that is failing, and says when to return', async () => {
      const { client, calls } = harness(Array.from({ length: 3 }, () => body(500)), {
        retry: { attempts: 3 },
        breaker: { minimumThroughput: 3, failureRateThreshold: 0.5, openMs: 30_000, openJitterRatio: 0 },
      });

      await client.fetch('https://payments.test/charges');
      expect(client.breaker.state).toBe('open');

      // The point of the whole mechanism: the next caller pays nothing. No
      // socket, no timeout, no share of the event loop.
      const refused: unknown = await client.fetch('https://payments.test/charges').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(CircuitOpenError);
      expect((refused as CircuitOpenError).headers).toEqual({ 'Retry-After': '30' });
      expect(calls).toHaveLength(3);
    });

    it('counts attempts, not calls', async () => {
      // Three attempts of one call is three times the load on the failing
      // dependency, which is exactly why the breaker sits inside the loop: from
      // outside it would see one outcome, count a third of the real traffic,
      // and shed load a window later than it should.
      const { client } = harness(Array.from({ length: 3 }, () => body(500)), {
        retry: { attempts: 3 },
        breaker: { minimumThroughput: 3, failureRateThreshold: 1 },
      });

      await client.fetch('https://payments.test/charges');

      expect(client.breaker.stats()).toMatchObject({ failures: 3, successes: 0 });
    });

    it('is not opened by a caller asking for something that is not there', async () => {
      const { client } = harness(Array.from({ length: 5 }, () => body(404)));

      for (let i = 0; i < 5; i += 1) await client.fetch('https://payments.test/charges/missing');

      expect(client.breaker.state).toBe('closed');
      expect(client.breaker.stats().failures).toBe(0);
    });

    it('reports the fault it has in hand rather than the mechanism', async () => {
      const { client } = harness([body(500), body(500), body(500)], {
        retry: { attempts: 4 },
        breaker: { minimumThroughput: 3, failureRateThreshold: 0.5 },
      });

      // The circuit opens partway through this call's own ladder — its own
      // attempts are what tripped it. The caller's log should say "the origin
      // returned 500", not "circuit open", when there is a 500 to report.
      const response = await client.fetch('https://payments.test/charges');

      expect(response.status).toBe(500);
      expect(client.breaker.state).toBe('open');
    });

    it('recovers through a probe once the dependency answers again', async () => {
      let now = Date.parse('2026-03-01T12:00:00.000Z');
      const { client, calls } = harness(
        [body(500), body(500), body(500), body(200)],
        {
          retry: { attempts: 3 },
          now: () => now,
          breaker: {
            minimumThroughput: 3,
            failureRateThreshold: 0.5,
            openMs: 30_000,
            openJitterRatio: 0,
            now: () => now,
          },
        },
      );

      await client.fetch('https://payments.test/charges');
      expect(client.breaker.state).toBe('open');

      now += 30_000;
      const response = await client.fetch('https://payments.test/charges');

      expect(response.status).toBe(200);
      expect(client.breaker.state).toBe('closed');
      expect(calls).toHaveLength(4);
    });
  });

  describe('a caller that walked away', () => {
    it('stops the ladder and does not blame the dependency', async () => {
      const controller = new AbortController();
      const { client, calls } = harness([
        () => {
          controller.abort(new Error('client hung up'));
          return transportFailure();
        },
      ]);

      await expect(
        client.fetch('https://payments.test/charges', { signal: controller.signal }),
      ).rejects.toThrow('client hung up');

      // Recording this would open circuits during a rolling deploy, when every
      // in-flight request is cancelled and every upstream is healthy.
      expect(client.breaker.stats()).toMatchObject({ failures: 0, successes: 0 });
      expect(calls).toHaveLength(1);
    });

    it('makes no attempt at all once the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('too late'));
      const { client, calls } = harness([body(200)]);

      await expect(
        client.fetch('https://payments.test/charges', { signal: controller.signal }),
      ).rejects.toThrow('too late');
      expect(calls).toHaveLength(0);
    });
  });

  describe('configuration', () => {
    it('refuses a ladder that never widens', () => {
      expect(() =>
        createHttpClient({ name: 'payments', retry: { baseDelayMs: 500, maxDelayMs: 100 } }),
      ).toThrow(RangeError);
    });

    it('refuses a nonsense attempt count', () => {
      expect(() => createHttpClient({ name: 'payments', retry: { attempts: 0 } })).toThrow(
        RangeError,
      );
    });
  });
});
