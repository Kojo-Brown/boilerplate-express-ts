import {
  DependencyTimeoutError,
  guardBodyIdle,
  startAttemptDeadlines,
} from '@/resilience/deadlines';

/** A source whose chunks this file decides on, one at a time. */
function controllableBody(): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly push: (text: string) => void;
  readonly finish: () => void;
  readonly fail: (err: Error) => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (text) => controller.enqueue(encoder.encode(text)),
    finish: () => controller.close(),
    fail: (err) => controller.error(err),
  };
}

/**
 * The abort reason, however late this is called.
 *
 * The `aborted` check first is not defensive padding: an abort that already
 * happened fires no further event, and two of the cases below abort
 * synchronously before a listener could be attached.
 */
function aborted(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
  });
}

describe('DependencyTimeoutError', () => {
  it('is a 504, because the dependency was asked and did not answer', () => {
    const err = new DependencyTimeoutError('payments', 'headers', 250);

    // The distinction that matters across all three: 503 means *we did not
    // ask* — a bulkhead or an open circuit declined on our own. 504 means we
    // asked. Only the second is a claim about the upstream, and only the second
    // should page whoever owns it.
    expect(err.statusCode).toBe(504);
    expect(err.code).toBe('DEPENDENCY_TIMEOUT');
    // No Retry-After: nothing here knows when the dependency will be well, and
    // inventing a number is worse than omitting one.
    expect(err.headers).toBeUndefined();
  });

  it.each([
    ['request', /did not complete the exchange within 250ms/],
    ['headers', /did not send response headers within 250ms/],
    ['body', /stalled for 250ms mid-body/],
  ] as const)('says which deadline fired for %s', (phase, message) => {
    const err = new DependencyTimeoutError('payments', phase, 250);

    expect(err.phase).toBe(phase);
    expect(err.message).toMatch(message);
    expect(err.message).toContain('payments');
  });
});

describe('startAttemptDeadlines', () => {
  it('aborts with a typed error when the headers never arrive', async () => {
    const deadlines = startAttemptDeadlines({
      client: 'payments',
      requestTimeoutMs: 5_000,
      headersTimeoutMs: 20,
    });

    const reason = await aborted(deadlines.signal);

    // Aborted *with* the error rather than aborted bare: `fetch` surfaces an
    // abort reason verbatim, so this is what the caller ends up catching — a
    // typed timeout instead of a `DOMException` that could equally have been
    // their own cancellation.
    expect(reason).toBeInstanceOf(DependencyTimeoutError);
    expect(reason).toMatchObject({ phase: 'headers', timeoutMs: 20 });
    deadlines.dispose();
  });

  it('stops the headers clock once they arrive, and keeps the request one', async () => {
    const deadlines = startAttemptDeadlines({
      client: 'payments',
      requestTimeoutMs: 40,
      headersTimeoutMs: 10,
    });

    deadlines.headersReceived();
    const reason = await aborted(deadlines.signal);

    // If `headersReceived` had not disarmed it, this would be the 10ms headers
    // deadline firing over a body that is still perfectly healthy.
    expect(reason).toMatchObject({ phase: 'request', timeoutMs: 40 });
    deadlines.dispose();
  });

  it('leaves only the whole-exchange deadline when no headers budget is set', async () => {
    const deadlines = startAttemptDeadlines({ client: 'payments', requestTimeoutMs: 20 });

    await expect(aborted(deadlines.signal)).resolves.toMatchObject({ phase: 'request' });
    deadlines.dispose();
  });

  it('folds in the caller’s own signal', async () => {
    const controller = new AbortController();
    const deadlines = startAttemptDeadlines({
      client: 'payments',
      callerSignal: controller.signal,
      requestTimeoutMs: 5_000,
    });

    controller.abort(new Error('client hung up'));

    await expect(aborted(deadlines.signal)).resolves.toMatchObject({
      message: 'client hung up',
    });
    deadlines.dispose();
  });

  it('releases both timers on dispose', async () => {
    const deadlines = startAttemptDeadlines({
      client: 'payments',
      requestTimeoutMs: 10,
      headersTimeoutMs: 5,
    });

    deadlines.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(deadlines.signal.aborted).toBe(false);
  });

  it('aborts on demand, which is how the body guard reaches the socket', async () => {
    const deadlines = startAttemptDeadlines({ client: 'payments', requestTimeoutMs: 5_000 });
    const stall = new DependencyTimeoutError('payments', 'body', 30);

    deadlines.abort(stall);

    await expect(aborted(deadlines.signal)).resolves.toBe(stall);
    deadlines.dispose();
  });
});

describe('guardBodyIdle', () => {
  it('passes a healthy body straight through', async () => {
    const body = controllableBody();
    const guarded = guardBodyIdle(new Response(body.stream, { status: 200 }), 1_000, () => {});

    body.push('hello ');
    body.push('world');
    body.finish();

    await expect(guarded.text()).resolves.toBe('hello world');
  });

  it('leaves a response with no body alone', () => {
    // A 204 has nothing to stall on, and the `Response` constructor refuses a
    // body for the null-body statuses — so wrapping one would throw where the
    // unguarded path returned fine.
    const original = new Response(null, { status: 204 });

    expect(guardBodyIdle(original, 10, () => {})).toBe(original);
  });

  it('fails the read when the origin goes quiet mid-body', async () => {
    const body = controllableBody();
    const stall = new DependencyTimeoutError('payments', 'body', 20);
    // Standing in for what the client does: `onStall` aborts the attempt's
    // signal, which errors the underlying response stream. Erroring the wrapper
    // alone would leave the socket allocated, which is the whole difference
    // between a stream decoration and a socket timeout.
    const guarded = guardBodyIdle(new Response(body.stream), 20, () => body.fail(stall));

    body.push('partial');

    await expect(guarded.text()).rejects.toBe(stall);
  });

  it('does not start the clock on a consumer that reads slowly', async () => {
    // Demand-driven `pull` is what makes this true, and it is the difference
    // between an idle-origin timeout and one that fails responses for being
    // read carefully.
    const body = controllableBody();
    const stalls: number[] = [];
    const guarded = guardBodyIdle(new Response(body.stream), 20, () => stalls.push(Date.now()));

    body.push('one');
    body.push('two');
    body.finish();
    await new Promise((resolve) => setTimeout(resolve, 60));

    await expect(guarded.text()).resolves.toBe('onetwo');
    expect(stalls).toEqual([]);
  });

  it('carries the response identity across the wrap', async () => {
    const body = controllableBody();
    const original = new Response(body.stream, {
      status: 418,
      statusText: 'I am a teapot',
      headers: { 'x-request-id': 'mock-request-id' },
    });
    Object.defineProperty(original, 'url', { value: 'https://payments.test/charges' });
    Object.defineProperty(original, 'redirected', { value: true });

    const guarded = guardBodyIdle(original, 1_000, () => {});
    body.finish();

    expect(guarded.status).toBe(418);
    expect(guarded.statusText).toBe('I am a teapot');
    expect(guarded.headers.get('x-request-id')).toBe('mock-request-id');
    // `redirect: "follow"` is fetch's default, so `url` is the only way a caller
    // learns where a request actually ended up. A constructed `Response` reports
    // an empty one; losing that silently in exchange for a timeout would be a
    // trade nobody asked for.
    expect(guarded.url).toBe('https://payments.test/charges');
    expect(guarded.redirected).toBe(true);
    await guarded.text();
  });

  it('cancels the underlying body when the caller cancels the wrapper', async () => {
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });

    const guarded = guardBodyIdle(new Response(stream), 1_000, () => {});
    await guarded.body?.cancel('caller gave up');

    expect(cancelled).toBe('caller gave up');
  });
});
