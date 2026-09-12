import type { Lifecycle } from '@/shutdown/lifecycle';

/**
 * The sequence a process runs when it is asked to go away, and the budget it
 * runs it in.
 *
 * Two things are being coordinated, and they pull in opposite directions.
 * *Order* matters, because closing the connection pool while a request is still
 * using it turns a graceful shutdown into a 500 the client did not have to see.
 * *Time* matters, because an orchestrator that sent `SIGTERM` has already
 * decided when it will send `SIGKILL`, and a sequence that is still tidying up
 * when that lands has achieved nothing — the work it was protecting dies anyway,
 * and so does everything else.
 *
 * So: phases run in order, tasks inside a phase run together, and the whole
 * thing shares one clock. The clock is shared rather than per-task on purpose. A
 * per-task timeout is a number that means nothing on its own — four tasks with a
 * ten-second timeout each is a forty-second shutdown inside a thirty-second
 * grace period — while one budget is the number the orchestrator is actually
 * configured with, minus a margin.
 */

/** One unit of teardown. */
export interface ShutdownTask {
  readonly name: string;
  /**
   * `signal` aborts when the budget is spent, and a task that can wind up early
   * should listen to it — the HTTP drain destroys what is left of its
   * connections, rather than being abandoned mid-wait with the sockets open.
   *
   * A task that ignores it is not awaited past the deadline. It keeps running
   * until the process exits, which is close behind.
   */
  run(signal: AbortSignal): Promise<void> | void;
}

/** Tasks that may run at the same time, because none of them needs another's result. */
export interface ShutdownPhase {
  readonly name: string;
  readonly tasks: readonly ShutdownTask[];
}

export type ShutdownTaskOutcome = 'completed' | 'failed' | 'timed-out' | 'skipped';

export interface ShutdownTaskResult {
  readonly phase: string;
  readonly task: string;
  readonly outcome: ShutdownTaskOutcome;
  readonly durationMs: number;
  readonly error?: unknown;
}

export interface ShutdownReport {
  /**
   * `clean` only when every task completed. Anything else is `degraded`, which
   * the process reports as a non-zero exit code: a deploy that is silently
   * dropping connections on every replacement looks exactly like a healthy one
   * from the outside, and the exit code is the only place it shows.
   */
  readonly outcome: 'clean' | 'degraded';
  /** What started it: a signal name, or whatever the caller passed. */
  readonly reason: string;
  readonly durationMs: number;
  readonly tasks: readonly ShutdownTaskResult[];
}

export interface GracefulShutdownOptions {
  readonly lifecycle: Lifecycle;
  readonly phases: readonly ShutdownPhase[];
  /**
   * The whole sequence's budget. Must sit *below* the orchestrator's grace
   * period — the difference is the margin in which the process gets to log what
   * it did and exit on its own terms rather than being killed mid-sentence.
   */
  readonly timeoutMs: number;
  /** Defaults to `console`. Injected so a test can read what was said. */
  readonly logger?: ShutdownLogger;
  /** Defaults to `process.exit`. Injected so a test does not end the runner. */
  readonly exit?: (code: number) => void;
}

export interface ShutdownLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface GracefulShutdown {
  /**
   * Runs the sequence. The second and later calls return the first one's
   * promise, so two signals arriving together do not tear down the pool twice.
   */
  shutdown(reason: string): Promise<ShutdownReport>;
  /**
   * Attaches the signal handlers and returns a function that removes them.
   *
   * Explicit rather than done on import, because a module that installs process
   * handlers when it is loaded cannot be unit tested and cannot be left out of a
   * deployment that has its own.
   */
  install(signals?: readonly NodeJS.Signals[]): () => void;
}

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

const consoleLogger: ShutdownLogger = {
  log: (message) => {
    console.log(message);
  },
  warn: (message) => {
    console.warn(message);
  },
  error: (message, error) => {
    console.error(message, error);
  },
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Awaits a task, or gives up on it when the budget runs out.
 *
 * The losing promise stays attached to the race rather than being dropped, so a
 * task that rejects after its deadline has passed is still handled — an
 * unhandled rejection during shutdown would take the process down with a stack
 * trace in place of the report.
 */
async function runTask(
  phase: ShutdownPhase,
  task: ShutdownTask,
  signal: AbortSignal,
  expired: Promise<void>,
): Promise<ShutdownTaskResult> {
  const startedAt = Date.now();

  if (signal.aborted) {
    return { phase: phase.name, task: task.name, outcome: 'skipped', durationMs: 0 };
  }

  const TIMED_OUT = Symbol('timed-out');

  try {
    const result = await Promise.race([
      Promise.resolve(task.run(signal)).then(() => undefined),
      expired.then(() => TIMED_OUT),
    ]);

    return {
      phase: phase.name,
      task: task.name,
      outcome: result === TIMED_OUT ? 'timed-out' : 'completed',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      phase: phase.name,
      task: task.name,
      outcome: 'failed',
      durationMs: Date.now() - startedAt,
      error,
    };
  }
}

export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const { lifecycle, phases, timeoutMs, logger = consoleLogger, exit = process.exit } = options;

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `createGracefulShutdown: timeoutMs must be a positive integer, received ${String(timeoutMs)}`,
    );
  }

  let running: Promise<ShutdownReport> | null = null;

  async function run(reason: string): Promise<ShutdownReport> {
    const startedAt = Date.now();
    lifecycle.beginDraining();
    logger.log(`[shutdown] ${reason}: draining, ${String(timeoutMs)}ms budget`);

    const budget = new AbortController();
    // Unref'd, so a sequence that finishes early does not then wait out its own
    // deadline before the event loop can empty.
    const timer = setTimeout(() => {
      budget.abort();
    }, timeoutMs);
    timer.unref();

    // One promise for the deadline, created once and awaited by every task.
    // Attaching a fresh listener per task would be the same thing with a warning
    // about listener leaks attached to it.
    const expired = new Promise<void>((resolve) => {
      budget.signal.addEventListener('abort', () => {
        resolve();
      }, { once: true });
    });

    const results: ShutdownTaskResult[] = [];

    for (const phase of phases) {
      const phaseResults = await Promise.all(
        phase.tasks.map((task) => runTask(phase, task, budget.signal, expired)),
      );
      results.push(...phaseResults);

      for (const result of phaseResults) {
        if (result.outcome === 'failed') {
          logger.error(`[shutdown] ${phase.name}/${result.task} failed:`, result.error);
        } else if (result.outcome === 'timed-out') {
          logger.warn(`[shutdown] ${phase.name}/${result.task} did not finish within the budget`);
        } else if (result.outcome === 'skipped') {
          logger.warn(`[shutdown] ${phase.name}/${result.task} skipped: budget already spent`);
        }
      }
    }

    clearTimeout(timer);
    lifecycle.markClosed();

    const degraded = results.some((result) => result.outcome !== 'completed');
    const durationMs = Date.now() - startedAt;
    const report: ShutdownReport = {
      outcome: degraded ? 'degraded' : 'clean',
      reason,
      durationMs,
      tasks: results,
    };

    const summary = `[shutdown] ${report.outcome} in ${String(durationMs)}ms (${results
      .map((result) => `${result.task}=${result.outcome}`)
      .join(', ')})`;

    if (degraded) logger.warn(summary);
    else logger.log(summary);

    return report;
  }

  function shutdown(reason: string): Promise<ShutdownReport> {
    running ??= run(reason);
    return running;
  }

  return {
    shutdown,

    install(signals: readonly NodeJS.Signals[] = DEFAULT_SIGNALS): () => void {
      const handlers = signals.map((signal) => {
        const handler = (): void => {
          // A second signal is an operator saying the sequence is taking too
          // long — an impatient `Ctrl-C`, or an orchestrator escalating. Honour
          // it: leaving them with a process that ignores repeated signals is how
          // people learn to reach for `kill -9`, which is the outcome this whole
          // module exists to avoid.
          if (running !== null) {
            logger.warn(`[shutdown] second ${signal} during shutdown, exiting now`);
            exit(1);
            return;
          }

          void shutdown(signal).then(
            (report) => {
              exit(report.outcome === 'clean' ? 0 : 1);
            },
            (error: unknown) => {
              // `run` catches per task, so reaching here means the sequencer
              // itself broke. Still an exit rather than a hang: whatever is
              // wrong, the process was asked to leave.
              logger.error('[shutdown] sequence failed:', describe(error));
              exit(1);
            },
          );
        };

        process.on(signal, handler);
        return { signal, handler };
      });

      return () => {
        for (const { signal, handler } of handlers) process.off(signal, handler);
      };
    },
  };
}

/**
 * A task that waits, and nothing else. The drain window.
 *
 * It looks like a placeholder and is the opposite of one: it is the only phase
 * that does no teardown, and removing it is what turns a rolling deploy into one
 * that drops requests. A load balancer notices an instance is unready by polling
 * it, so between the readiness answer flipping and the last request being routed
 * here there is a gap of up to one polling interval. Serving normally across
 * that gap is what makes the drain graceful; closing the listener inside it
 * means answering `ECONNREFUSED` to requests that were routed in good faith.
 *
 * Which is why the wait is not abortable by the shutdown budget: a wait that the
 * deadline can cut short is a wait that does not reliably happen. It is bounded
 * by its own duration, and the budget is expected to be larger.
 */
export function waitTask(name: string, ms: number): ShutdownTask {
  return {
    name,
    run(): Promise<void> {
      if (ms <= 0) return Promise.resolve();

      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },
  };
}
