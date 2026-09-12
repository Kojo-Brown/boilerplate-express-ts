import { createGracefulShutdown, waitTask } from '@/shutdown/graceful-shutdown';
import type {
  GracefulShutdownOptions,
  ShutdownLogger,
  ShutdownPhase,
  ShutdownTask,
} from '@/shutdown/graceful-shutdown';
import { createLifecycle } from '@/shutdown/lifecycle';

function silentLogger(): ShutdownLogger {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function options(overrides: Partial<GracefulShutdownOptions> = {}): GracefulShutdownOptions {
  return {
    lifecycle: createLifecycle(),
    phases: [],
    timeoutMs: 1_000,
    logger: silentLogger(),
    exit: jest.fn(),
    ...overrides,
  };
}

/**
 * Unref'd, because some of these waits are deliberately abandoned — the whole
 * point of the budget assertions is a task that never comes back — and a ref'd
 * five-second timer with nothing behind it is a worker Jest has to force-exit.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Records the order tasks start and finish in, which is what "phase" means. */
function recorder(): { log: string[]; task: (name: string, ms?: number) => ShutdownTask } {
  const log: string[] = [];

  return {
    log,
    task: (name, ms = 0) => ({
      name,
      run: async () => {
        log.push(`start:${name}`);
        if (ms > 0) await delay(ms);
        log.push(`end:${name}`);
      },
    }),
  };
}

describe('createGracefulShutdown', () => {
  it('refuses a budget that is not a positive integer', () => {
    expect(() => createGracefulShutdown(options({ timeoutMs: 0 }))).toThrow(RangeError);
    expect(() => createGracefulShutdown(options({ timeoutMs: 1.5 }))).toThrow(RangeError);
  });

  it('runs phases in order and the tasks inside one together', async () => {
    const { log, task } = recorder();
    const phases: ShutdownPhase[] = [
      { name: 'first', tasks: [task('a', 30), task('b', 30)] },
      { name: 'second', tasks: [task('c')] },
    ];

    const report = await createGracefulShutdown(options({ phases })).shutdown('test');

    expect(report.outcome).toBe('clean');
    // Both of the first phase's tasks start before either ends: concurrency
    // inside a phase is the point of grouping them.
    expect(log.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
    // And nothing from the second phase begins until the first has finished —
    // the ordering that keeps the pool open until the requests using it are done.
    expect(log.indexOf('start:c')).toBeGreaterThan(log.indexOf('end:a'));
    expect(log.indexOf('start:c')).toBeGreaterThan(log.indexOf('end:b'));
  });

  it('goes unready before the first task and closed after the last', async () => {
    const lifecycle = createLifecycle();
    const seen: boolean[] = [];
    const phases: ShutdownPhase[] = [
      {
        name: 'observe',
        tasks: [
          {
            name: 'readiness',
            run: () => {
              seen.push(lifecycle.isReady);
            },
          },
        ],
      },
    ];

    await createGracefulShutdown(options({ lifecycle, phases })).shutdown('SIGTERM');

    // Unready from the first instant, which is what gives the drain window
    // something to be a window on.
    expect(seen).toEqual([false]);
    expect(lifecycle.state).toBe('closed');
  });

  it('keeps going after a task throws, and reports degraded', async () => {
    const ran: string[] = [];
    const phases: ShutdownPhase[] = [
      {
        name: 'first',
        tasks: [
          {
            name: 'broken',
            run: () => Promise.reject(new Error('pool refused to close')),
          },
          {
            name: 'sibling',
            run: () => {
              ran.push('sibling');
            },
          },
        ],
      },
      {
        name: 'second',
        tasks: [
          {
            name: 'later',
            run: () => {
              ran.push('later');
            },
          },
        ],
      },
    ];

    const report = await createGracefulShutdown(options({ phases })).shutdown('test');

    // One resource that will not close is not a reason to abandon the rest of
    // them — that turns a degraded shutdown into a `kill -9`'s worth of damage.
    expect(ran).toEqual(['sibling', 'later']);
    expect(report.outcome).toBe('degraded');
    expect(report.tasks.find((result) => result.task === 'broken')).toMatchObject({
      outcome: 'failed',
    });
  });

  it('abandons a task that outlives the budget and skips the phases behind it', async () => {
    let aborted = false;
    const phases: ShutdownPhase[] = [
      {
        name: 'slow',
        tasks: [
          {
            name: 'wedged',
            run: (signal) => {
              signal.addEventListener('abort', () => {
                aborted = true;
              });
              return delay(5_000);
            },
          },
        ],
      },
      { name: 'later', tasks: [{ name: 'never-runs', run: jest.fn() }] },
    ];

    const report = await createGracefulShutdown(options({ phases, timeoutMs: 50 })).shutdown('test');

    expect(report.outcome).toBe('degraded');
    expect(report.tasks).toMatchObject([
      { task: 'wedged', outcome: 'timed-out' },
      { task: 'never-runs', outcome: 'skipped' },
    ]);
    // The signal is how a task that *can* wind up early gets told to: the HTTP
    // drain destroys its remaining connections rather than leaving them open on
    // a process that is about to vanish.
    expect(aborted).toBe(true);
  });

  it('handles a task that rejects after its own deadline has passed', async () => {
    // An unhandled rejection during shutdown would take the process down with a
    // stack trace where the report should be.
    const phases: ShutdownPhase[] = [
      {
        name: 'slow',
        tasks: [
          {
            name: 'late-failure',
            run: async () => {
              await delay(60);
              throw new Error('too late to matter');
            },
          },
        ],
      },
    ];

    const report = await createGracefulShutdown(options({ phases, timeoutMs: 20 })).shutdown('test');

    expect(report.tasks[0]).toMatchObject({ task: 'late-failure', outcome: 'timed-out' });
    await delay(80);
  });

  it('runs once however many times it is asked', async () => {
    const run = jest.fn();
    const phases: ShutdownPhase[] = [{ name: 'only', tasks: [{ name: 'once', run }] }];
    const shutdown = createGracefulShutdown(options({ phases }));

    const [first, second] = await Promise.all([shutdown.shutdown('a'), shutdown.shutdown('b')]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.reason).toBe('a');
  });

  describe('install', () => {
    let uninstall: (() => void) | null = null;

    afterEach(() => {
      uninstall?.();
      uninstall = null;
    });

    it('shuts down on a signal and exits 0 when the sequence was clean', async () => {
      const exit = jest.fn();
      const run = jest.fn();
      const shutdown = createGracefulShutdown(
        options({ exit, phases: [{ name: 'only', tasks: [{ name: 'task', run }] }] }),
      );
      uninstall = shutdown.install(['SIGUSR2']);

      process.emit('SIGUSR2');
      await shutdown.shutdown('unused');
      await delay(0);

      expect(run).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('exits non-zero when something did not close', async () => {
      const exit = jest.fn();
      const shutdown = createGracefulShutdown(
        options({
          exit,
          phases: [
            { name: 'only', tasks: [{ name: 'task', run: () => Promise.reject(new Error('no')) }] },
          ],
        }),
      );
      uninstall = shutdown.install(['SIGUSR2']);

      process.emit('SIGUSR2');
      await shutdown.shutdown('unused');
      await delay(0);

      // The only place a deploy that is quietly cutting connections on every
      // replaced replica shows up from the outside.
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('exits immediately on a second signal', async () => {
      const exit = jest.fn();
      const logger = silentLogger();
      const shutdown = createGracefulShutdown(
        options({
          exit,
          logger,
          phases: [{ name: 'slow', tasks: [{ name: 'task', run: () => delay(200) }] }],
        }),
      );
      uninstall = shutdown.install(['SIGUSR2']);

      process.emit('SIGUSR2');
      process.emit('SIGUSR2');

      // Honoured rather than ignored: a process that swallows repeated signals
      // is how people learn to reach for `kill -9`.
      expect(exit).toHaveBeenCalledWith(1);
      await shutdown.shutdown('unused');
    });

    it('removes its handlers', async () => {
      const run = jest.fn();
      const shutdown = createGracefulShutdown(
        options({ phases: [{ name: 'only', tasks: [{ name: 'task', run }] }] }),
      );
      const remove = shutdown.install(['SIGUSR2']);
      const before = process.listenerCount('SIGUSR2');

      remove();

      expect(process.listenerCount('SIGUSR2')).toBe(before - 1);
      expect(run).not.toHaveBeenCalled();
    });
  });
});

describe('waitTask', () => {
  it('waits for its full duration', async () => {
    const startedAt = Date.now();

    await waitTask('drain', 60).run(new AbortController().signal);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it('returns immediately when the window is disabled', async () => {
    const startedAt = Date.now();

    await waitTask('drain', 0).run(new AbortController().signal);

    expect(Date.now() - startedAt).toBeLessThan(30);
  });

  it('is not cut short by the shutdown budget', async () => {
    // A wait the deadline can interrupt is a wait that does not reliably happen,
    // and the balancer's polling interval does not care that we are in a hurry.
    const budget = new AbortController();
    budget.abort();
    const startedAt = Date.now();

    await waitTask('drain', 60).run(budget.signal);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });
});
