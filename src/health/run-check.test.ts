import { runCheck, runChecks } from '@/health/run-check';
import type { DependencyCheck } from '@/health/health.types';

function check(
  name: string,
  run: DependencyCheck['run'],
  criticality: DependencyCheck['criticality'] = 'critical',
): DependencyCheck {
  return { name, criticality, run };
}

/** A promise plus the handles to settle it from the test body. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runCheck', () => {
  it('reports a check that resolves as ok, with its cost', async () => {
    const result = await runCheck(
      check('postgres', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
      { timeoutMs: 1_000 },
    );

    expect(result).toMatchObject({ name: 'postgres', criticality: 'critical', status: 'ok' });
    expect(result.durationMs).toBeGreaterThanOrEqual(4);
    expect(result.error).toBeUndefined();
  });

  it('reduces a throwing check to a failed result rather than rejecting', async () => {
    const result = await runCheck(
      check('postgres', () => Promise.reject(new Error('ECONNREFUSED 10.0.0.4:5432'))),
      { timeoutMs: 1_000 },
    );

    expect(result.status).toBe('failed');
    // Recorded at this layer unconditionally. Whether it reaches a client is
    // `redactReport`'s decision, made once at the edge.
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('catches a check that throws synchronously', async () => {
    const result = await runCheck(
      check('broken', () => {
        throw new Error('constructed wrong');
      }),
      { timeoutMs: 1_000 },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('constructed wrong');
  });

  it('answers on its own deadline even when the check ignores the signal', async () => {
    // The case the race exists for: a dependency that accepts the connection
    // and then says nothing. Cooperation cannot be assumed of the clients most
    // likely to hang, so the endpoint has to be bounded without it.
    const never = deferred<void>();

    const result = await runCheck(check('stuck', () => never.promise), { timeoutMs: 20 });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('did not answer within 20ms');

    // Measured rather than asserted from the code: the abandoned promise
    // settles after nobody is waiting, and unhandled that rejection terminates
    // the process on every supported Node version — a readiness probe that
    // kills the service because a dependency was slow. Removing the swallow in
    // `runCheck` makes this listener fire.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      never.reject(new Error('answered after the deadline'));
      // Two turns: one for the rejection to propagate, one for Node to decide
      // nobody handled it.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('aborts the signal so a cooperating check can let go of what it holds', async () => {
    let reason: unknown;
    const released = deferred<void>();

    const result = await runCheck(
      check('cooperative', async (signal) => {
        signal.addEventListener('abort', () => {
          reason = signal.reason;
          released.resolve();
        });
        await new Promise(() => {
          /* never settles on its own */
        });
      }),
      { timeoutMs: 20 },
    );

    expect(result.status).toBe('failed');
    await released.promise;
    expect(reason).toMatchObject({ name: 'HealthCheckTimeoutError', checkName: 'cooperative' });
  });

  it('does not abort a check that answered in time', async () => {
    let aborted: boolean | undefined;

    await runCheck(
      check('quick', async (signal) => {
        await Promise.resolve();
        aborted = signal.aborted;
      }),
      { timeoutMs: 1_000 },
    );

    expect(aborted).toBe(false);
  });
});

describe('runChecks', () => {
  it('runs them concurrently, so the worst case is the slowest and not the sum', async () => {
    const started: string[] = [];
    const gate = deferred<void>();

    const all = runChecks(
      [
        check('a', async () => {
          started.push('a');
          await gate.promise;
        }),
        check('b', async () => {
          started.push('b');
          await gate.promise;
        }),
      ],
      { timeoutMs: 1_000 },
    );

    // Both are already running while neither has finished. Sequentially, `b`
    // would not have started — which is how four 2s budgets become an 8s answer
    // to a probe that gives up at 5.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['a', 'b']);

    gate.resolve();
    expect((await all).map((result) => result.status)).toEqual(['ok', 'ok']);
  });

  it('keeps registration order, so one failure does not hide the others', async () => {
    const results = await runChecks(
      [
        check('postgres', () => Promise.reject(new Error('down'))),
        check('redis', () => Promise.resolve(), 'optional'),
      ],
      { timeoutMs: 1_000 },
    );

    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['postgres', 'failed'],
      ['redis', 'ok'],
    ]);
  });

  it('returns an empty report for an empty registry rather than failing', async () => {
    // The shape every e2e suite in this repository gets: an app built without a
    // process behind it registers nothing, and a process that depends on
    // nothing is ready.
    expect(await runChecks([], { timeoutMs: 1_000 })).toEqual([]);
  });
});
