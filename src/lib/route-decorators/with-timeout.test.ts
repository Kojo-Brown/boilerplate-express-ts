import type { Request } from 'express';
import { AppError } from '@/lib/errors';
import type { OperationContext } from '@/lib/route-decorators/types';
import { TimeoutError, withTimeout } from '@/lib/route-decorators/with-timeout';

function makeRequest(overrides: Partial<Request> = {}): Request {
  return { method: 'GET', originalUrl: '/v1/things', ...overrides } as Request;
}

function makeContext(signal: AbortSignal = new AbortController().signal): OperationContext {
  return { signal, attempt: 1, meta: {} };
}

/** Resolves after `ms` of *fake* time. */
function sleepFake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects with the ms it was configured with once the timer fires', async () => {
    const decorated = withTimeout(async () => sleepFake(500), { ms: 100 });

    const settled = decorated(makeRequest(), makeContext());
    const assertion = expect(settled).rejects.toThrow('Operation timed out after 100ms');
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('resolves untouched when the operation beats the deadline', async () => {
    const decorated = withTimeout(
      async () => {
        await sleepFake(10);
        return 'done';
      },
      { ms: 100 },
    );

    const settled = decorated(makeRequest(), makeContext());
    await jest.advanceTimersByTimeAsync(10);

    await expect(settled).resolves.toBe('done');
  });

  it('surfaces as a 504 through the existing AppError chain', async () => {
    const decorated = withTimeout(async () => sleepFake(500), { ms: 50, label: 'User lookup' });

    const settled = decorated(makeRequest(), makeContext()).catch((err: unknown) => err);
    await jest.advanceTimersByTimeAsync(50);
    const err = await settled;

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      statusCode: 504,
      code: 'TIMEOUT',
      message: 'User lookup timed out after 50ms',
      name: 'TimeoutError',
    });
  });

  it('aborts the operation signal rather than leaving the work running', async () => {
    let observed: unknown;
    const decorated = withTimeout(
      async (_req, ctx) => {
        ctx.signal.addEventListener('abort', () => {
          observed = ctx.signal.reason;
        });
        return sleepFake(500);
      },
      { ms: 100 },
    );

    const settled = decorated(makeRequest(), makeContext()).catch(() => undefined);
    await jest.advanceTimersByTimeAsync(100);
    await settled;

    expect(observed).toBeInstanceOf(TimeoutError);
  });

  it('propagates an outer abort inward without waiting for its own deadline', async () => {
    const outer = new AbortController();
    let innerAborted = false;

    const decorated = withTimeout(
      async (_req, ctx) => {
        ctx.signal.addEventListener('abort', () => {
          innerAborted = true;
        });
        return sleepFake(10_000);
      },
      { ms: 10_000 },
    );

    void decorated(makeRequest(), makeContext(outer.signal)).catch(() => undefined);
    await Promise.resolve();
    outer.abort(new Error('client gone'));
    await Promise.resolve();

    expect(innerAborted).toBe(true);
  });

  it('aborts immediately when the signal was already aborted at entry', async () => {
    const outer = new AbortController();
    outer.abort(new Error('already gone'));
    let seenAborted: boolean | undefined;

    const decorated = withTimeout(
      async (_req, ctx) => {
        seenAborted = ctx.signal.aborted;
        return 'value';
      },
      { ms: 100 },
    );

    await expect(decorated(makeRequest(), makeContext(outer.signal))).resolves.toBe('value');
    expect(seenAborted).toBe(true);
  });

  it('propagates the operation error unchanged when it loses to nothing', async () => {
    const boom = new AppError(503, 'upstream down', 'UPSTREAM_DOWN');
    const decorated = withTimeout(
      async () => {
        await sleepFake(10);
        throw boom;
      },
      { ms: 100 },
    );

    const settled = decorated(makeRequest(), makeContext());
    const assertion = expect(settled).rejects.toBe(boom);
    await jest.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it('clears the timer on success so nothing keeps the loop alive', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const decorated = withTimeout(async () => 'fast', { ms: 100 });

    await decorated(makeRequest(), makeContext());

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('rejects a nonsensical deadline at wiring time, not on the first request', () => {
    const op = async (): Promise<string> => 'x';

    expect(() => withTimeout(op, { ms: 0 })).toThrow(RangeError);
    expect(() => withTimeout(op, { ms: -1 })).toThrow(RangeError);
    expect(() => withTimeout(op, { ms: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
