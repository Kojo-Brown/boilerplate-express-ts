import type { Request } from 'express';
import { AppError, ValidationError } from '@/lib/errors';
import type { OperationContext } from '@/lib/route-decorators/types';
import { isTransientError, withRetry } from '@/lib/route-decorators/with-retry';

function makeRequest(method = 'GET'): Request {
  return { method, originalUrl: '/v1/things' } as Request;
}

function makeContext(signal: AbortSignal = new AbortController().signal): OperationContext {
  return { signal, attempt: 1, meta: {} };
}

/** Records what it was asked to wait for and returns instantly. */
function recordingSleep(): { fn: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    fn: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe('isTransientError', () => {
  it('retries 5xx AppErrors', () => {
    expect(isTransientError(new AppError(500, 'boom'))).toBe(true);
    expect(isTransientError(new AppError(503, 'unavailable'))).toBe(true);
  });

  it('does not retry 4xx AppErrors — the answer will not change', () => {
    expect(isTransientError(new AppError(404, 'not found', 'NOT_FOUND'))).toBe(false);
    expect(isTransientError(new AppError(409, 'conflict', 'CONFLICT'))).toBe(false);
    expect(isTransientError(new ValidationError([]))).toBe(false);
  });

  it('retries anything that is not an AppError as infrastructure noise', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientError('a thrown string')).toBe(true);
  });
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = recordingSleep();
    const op = jest.fn(async () => 'ok');
    const decorated = withRetry(op, { attempts: 3, sleep: sleep.fn });

    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep.waits).toEqual([]);
  });

  it('re-runs a transient failure and succeeds on a later attempt', async () => {
    const sleep = recordingSleep();
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok');

    const decorated = withRetry(op, { attempts: 3, sleep: sleep.fn, random: () => 1 });

    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('gives up after `attempts` and rethrows the last error', async () => {
    const sleep = recordingSleep();
    const last = new Error('still down');
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValue(last);

    const decorated = withRetry(op, { attempts: 3, sleep: sleep.fn });

    await expect(decorated(makeRequest(), makeContext())).rejects.toBe(last);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('stops at the first non-retryable error', async () => {
    const notFound = new AppError(404, 'nope', 'NOT_FOUND');
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(notFound);
    const decorated = withRetry(op, { attempts: 5, sleep: recordingSleep().fn });

    await expect(decorated(makeRequest(), makeContext())).rejects.toBe(notFound);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('honours a custom retry predicate', async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new AppError(429, 'slow down', 'TOO_MANY_REQUESTS'))
      .mockResolvedValue('ok');

    const decorated = withRetry(op, {
      attempts: 2,
      sleep: recordingSleep().fn,
      isRetryable: (err) => err instanceof AppError && err.statusCode === 429,
    });

    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially and caps the step', async () => {
    const sleep = recordingSleep();
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('down'));

    // `random: () => 1` pins full jitter to its ceiling so the schedule is
    // exactly the cap sequence: 50, 100, 200, 200 (capped at maxDelayMs).
    const decorated = withRetry(op, {
      attempts: 5,
      baseDelayMs: 50,
      maxDelayMs: 200,
      sleep: sleep.fn,
      random: () => 1,
    });

    await expect(decorated(makeRequest(), makeContext())).rejects.toThrow('down');
    expect(sleep.waits).toEqual([50, 100, 200, 200]);
  });

  it('applies full jitter, so two clients failing together do not resynchronise', async () => {
    const sleep = recordingSleep();
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('down'));

    const decorated = withRetry(op, {
      attempts: 3,
      baseDelayMs: 100,
      sleep: sleep.fn,
      random: () => 0.25,
    });

    await expect(decorated(makeRequest(), makeContext())).rejects.toThrow('down');
    expect(sleep.waits).toEqual([25, 50]);
  });

  it('runs a POST exactly once — replaying it would write twice', async () => {
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('ECONNRESET'));
    const decorated = withRetry(op, { attempts: 4, sleep: recordingSleep().fn });

    await expect(decorated(makeRequest('POST'), makeContext())).rejects.toThrow('ECONNRESET');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('replays a POST when the caller declares the operation idempotent in fact', async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok');

    const decorated = withRetry(op, {
      attempts: 3,
      retryNonIdempotent: true,
      sleep: recordingSleep().fn,
    });

    await expect(decorated(makeRequest('POST'), makeContext())).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'get', 'delete'])(
    'treats %s as replayable',
    async (method) => {
      const op = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('ok');

      const decorated = withRetry(op, { attempts: 2, sleep: recordingSleep().fn });

      await expect(decorated(makeRequest(method), makeContext())).resolves.toBe('ok');
      expect(op).toHaveBeenCalledTimes(2);
    },
  );

  it('increments ctx.attempt so the operation can see which try it is on', async () => {
    const seen: number[] = [];
    const op = jest.fn(async (_req: Request, ctx: OperationContext) => {
      seen.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error('again');
      return 'ok';
    });

    const decorated = withRetry(op, { attempts: 3, sleep: recordingSleep().fn });

    await expect(decorated(makeRequest(), makeContext())).resolves.toBe('ok');
    expect(seen).toEqual([1, 2, 3]);
  });

  it('records the attempt count in meta only when it took more than one', async () => {
    const quiet = makeContext();
    await withRetry(async () => 'ok', { attempts: 3 })(makeRequest(), quiet);
    expect(quiet.meta).toEqual({});

    const noisy = makeContext();
    const flaky = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue('ok');
    await withRetry(flaky, { attempts: 3, sleep: recordingSleep().fn })(makeRequest(), noisy);
    expect(noisy.meta).toEqual({ attempts: 2 });
  });

  it('stops retrying once the signal is aborted mid-flight', async () => {
    const controller = new AbortController();
    const op = jest.fn(async () => {
      controller.abort(new Error('client gone'));
      throw new Error('ECONNRESET');
    });

    const decorated = withRetry(op, { attempts: 5, sleep: recordingSleep().fn });

    await expect(decorated(makeRequest(), makeContext(controller.signal))).rejects.toThrow(
      'ECONNRESET',
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client gone'));
    const op = jest.fn(async () => 'ok');

    await expect(
      withRetry(op, { attempts: 3 })(makeRequest(), makeContext(controller.signal)),
    ).rejects.toThrow('client gone');
    expect(op).not.toHaveBeenCalled();
  });

  it('aborts the real backoff sleep instead of waiting it out', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const op = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('ECONNRESET'));
      // No injected sleep: this exercises the real timer-backed one.
      const settled = withRetry(op, { attempts: 3, baseDelayMs: 10_000 })(
        makeRequest(),
        makeContext(controller.signal),
      ).catch((err: unknown) => err);

      await Promise.resolve();
      await Promise.resolve();
      controller.abort(new Error('client gone'));

      await expect(settled).resolves.toMatchObject({ message: 'client gone' });
      expect(op).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a nonsensical attempt count at wiring time', () => {
    const op = async (): Promise<string> => 'x';

    expect(() => withRetry(op, { attempts: 0 })).toThrow(RangeError);
    expect(() => withRetry(op, { attempts: -1 })).toThrow(RangeError);
    expect(() => withRetry(op, { attempts: 1.5 })).toThrow(RangeError);
  });
});
