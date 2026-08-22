import {
  WorkerCrashedError,
  WorkerPoolClosedError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '@/workers/pool.errors';
import type { TaskRequest } from '@/workers/protocol';
import { WorkerPool } from '@/workers/worker-pool';
import type { PoolWorker } from '@/workers/worker-pool';

/**
 * A `PoolWorker` that never starts a thread.
 *
 * The pool's own behaviour — admission, bounding, FIFO, timeout, replacement,
 * drain — is scheduling logic, and driving it through real threads would make
 * every case here a race with a real CPU. The fake makes each one exact: a task
 * is answered when this test says so and not before.
 *
 * `worker-pool.integration.test.ts` covers what this cannot: that
 * `nodeWorkerFactory` and the entry-point resolution actually produce a thread
 * that speaks the same protocol.
 */
class FakeWorker implements PoolWorker {
  static instances: FakeWorker[] = [];

  readonly received: TaskRequest[] = [];
  terminateCount = 0;
  unrefCount = 0;
  /** Set by a test to make `postMessage` fail the way a non-cloneable payload does. */
  postMessageError: Error | null = null;

  private messageListener: ((value: unknown) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private exitListener: ((code: number) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(value: unknown): void {
    if (this.postMessageError !== null) throw this.postMessageError;
    this.received.push(value as TaskRequest);
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  onExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }

  terminate(): Promise<unknown> {
    this.terminateCount += 1;
    return Promise.resolve(0);
  }

  unref(): void {
    this.unrefCount += 1;
  }

  // --- test controls -------------------------------------------------------

  /** The id of the task currently on this worker. */
  currentId(): number {
    const last = this.received[this.received.length - 1];
    if (last === undefined) throw new Error('this worker has never been sent a task');
    return last.id;
  }

  succeed(value: unknown, id: number = this.currentId()): void {
    this.emit({ kind: 'result', id, ok: true, value });
  }

  fail(error: { name: string; message: string; code?: string; statusCode?: number }): void {
    this.emit({ kind: 'result', id: this.currentId(), ok: false, error });
  }

  emit(value: unknown): void {
    this.messageListener?.(value);
  }

  crash(error: Error): void {
    this.errorListener?.(error);
  }

  exit(code: number): void {
    this.exitListener?.(code);
  }
}

type TestTasks = {
  readonly echo: { readonly payload: string; readonly result: string };
};

interface BuildOptions {
  size?: number;
  maxQueueDepth?: number;
  taskTimeoutMs?: number;
  retryAfterSeconds?: number;
  onWorkerError?: (error: unknown) => void;
}

/**
 * Every pool built by a test, so `afterEach` can close it.
 *
 * Not tidiness — a correctness property of the pool leaks into the test process
 * otherwise. A task's timeout timer is deliberately *not* `unref`'d (see
 * `WorkerPool`), so a case that leaves a task outstanding leaves a live handle
 * holding the jest worker open until jest force-exits it. `terminate()` clears
 * those timers, which is exactly the escape hatch it exists to be.
 */
const pools: WorkerPool<TestTasks>[] = [];

function buildPool(options: BuildOptions = {}): WorkerPool<TestTasks> {
  const pool = new WorkerPool<TestTasks>({
    createWorker: () => new FakeWorker(),
    size: options.size ?? 2,
    maxQueueDepth: options.maxQueueDepth ?? 2,
    taskTimeoutMs: options.taskTimeoutMs ?? 1_000,
    ...(options.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
    onWorkerError: options.onWorkerError ?? ((): void => {}),
  });

  pools.push(pool);
  return pool;
}

/** Lets already-queued microtasks run, so a synchronous rejection is observable. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  FakeWorker.instances = [];
  pools.length = 0;
});

afterEach(async () => {
  // Rejections from tasks abandoned by a test are expected here and are already
  // handled by the `.catch(() => {})` at each call site.
  await Promise.all(pools.map((pool) => pool.terminate()));
});

describe('construction', () => {
  it.each([
    ['size', { size: 0 }],
    ['size', { size: 1.5 }],
    ['taskTimeoutMs', { taskTimeoutMs: 0 }],
    ['maxQueueDepth', { maxQueueDepth: -1 }],
    ['retryAfterSeconds', { retryAfterSeconds: 0 }],
  ])('rejects a nonsense %s at construction rather than under load', (name, options) => {
    expect(() => buildPool(options)).toThrow(new RegExp(name));
    expect(() => buildPool(options)).toThrow(RangeError);
  });

  it('accepts maxQueueDepth 0, which means "no queue at all"', () => {
    expect(() => buildPool({ maxQueueDepth: 0 })).not.toThrow();
  });

  it('spawns no threads until the first task', () => {
    const pool = buildPool();

    expect(FakeWorker.instances).toHaveLength(0);
    expect(pool.stats()).toMatchObject({ spawned: 0, state: 'open' });
  });
});

describe('running tasks', () => {
  it('sends the task to a worker and resolves with its result', async () => {
    const pool = buildPool();

    const result = pool.run('echo', 'hello');
    await flush();

    const worker = FakeWorker.instances[0];
    expect(worker?.received[0]).toMatchObject({ kind: 'task', task: 'echo', payload: 'hello' });

    worker?.succeed('HELLO');
    await expect(result).resolves.toBe('HELLO');
  });

  it('unrefs every worker so an idle pool never keeps the process alive', async () => {
    const pool = buildPool();

    void pool.run('echo', 'a').catch(() => {});
    await flush();

    expect(FakeWorker.instances[0]?.unrefCount).toBe(1);
  });

  it('reuses an idle worker instead of spawning a second', async () => {
    const pool = buildPool();

    const first = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.succeed('A');
    await first;

    const second = pool.run('echo', 'b');
    await flush();

    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0]?.succeed('B');
    await expect(second).resolves.toBe('B');
  });

  it('spawns up to size and no further', async () => {
    const pool = buildPool({ size: 2, maxQueueDepth: 5 });

    void pool.run('echo', 'a').catch(() => {});
    void pool.run('echo', 'b').catch(() => {});
    void pool.run('echo', 'c').catch(() => {});
    await flush();

    expect(FakeWorker.instances).toHaveLength(2);
    expect(pool.stats()).toMatchObject({ spawned: 2, busy: 2, queued: 1 });
  });

  it('rehydrates a task failure, preserving the status the task chose', async () => {
    const pool = buildPool();

    const result = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.fail({
      name: 'AppError',
      message: 'bad input',
      code: 'BAD_INPUT',
      statusCode: 422,
    });

    await expect(result).rejects.toMatchObject({
      name: 'WorkerTaskError',
      message: 'bad input',
      code: 'BAD_INPUT',
      statusCode: 422,
      remoteName: 'AppError',
      task: 'echo',
    });
    await expect(result).rejects.toBeInstanceOf(WorkerTaskError);
  });

  it('defaults a task failure with no status to 500', async () => {
    const pool = buildPool();

    const result = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.fail({ name: 'TypeError', message: 'nope' });

    await expect(result).rejects.toMatchObject({
      statusCode: 500,
      code: 'WORKER_TASK_FAILED',
    });
  });

  it('returns the worker to the pool after a failure — the thread is fine', async () => {
    const pool = buildPool();

    const first = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.fail({ name: 'Error', message: 'nope' });
    await expect(first).rejects.toThrow();

    const second = pool.run('echo', 'b');
    await flush();

    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0]?.succeed('B');
    await expect(second).resolves.toBe('B');
  });

  it('fails only the caller when the payload cannot be cloned, keeping the worker', async () => {
    const pool = buildPool();

    // Warm one worker up so the failing send lands on an existing thread.
    const warm = pool.run('echo', 'warm');
    await flush();
    FakeWorker.instances[0]?.succeed('WARM');
    await warm;

    const worker = FakeWorker.instances[0];
    if (worker === undefined) throw new Error('expected a worker');
    worker.postMessageError = new Error('could not be cloned');

    await expect(pool.run('echo', 'bad')).rejects.toThrow('could not be cloned');

    worker.postMessageError = null;
    const next = pool.run('echo', 'ok');
    await flush();
    expect(FakeWorker.instances).toHaveLength(1);
    worker.succeed('OK');
    await expect(next).resolves.toBe('OK');
  });

  it('ignores a response whose id belongs to no live task', async () => {
    const pool = buildPool();

    const result = pool.run('echo', 'a');
    await flush();
    const worker = FakeWorker.instances[0];

    worker?.emit({ kind: 'result', id: 9999, ok: true, value: 'stale' });
    worker?.emit({ kind: 'progress', id: worker.currentId(), percent: 50 });
    worker?.succeed('REAL');

    await expect(result).resolves.toBe('REAL');
  });
});

describe('the bounded queue', () => {
  it('queues past capacity and dispatches in FIFO order as workers free up', async () => {
    const pool = buildPool({ size: 1, maxQueueDepth: 3 });

    const first = pool.run('echo', 'first');
    const second = pool.run('echo', 'second');
    const third = pool.run('echo', 'third');
    await flush();

    const worker = FakeWorker.instances[0];
    if (worker === undefined) throw new Error('expected a worker');
    expect(worker.received).toHaveLength(1);
    expect(pool.stats().queued).toBe(2);

    worker.succeed('1');
    await first;
    await flush();
    expect(worker.received[1]?.payload).toBe('second');

    worker.succeed('2');
    await second;
    await flush();
    expect(worker.received[2]?.payload).toBe('third');

    worker.succeed('3');
    await expect(third).resolves.toBe('3');
  });

  /**
   * The item's whole point. Beyond the bound the answer is immediate and
   * actionable rather than an unbounded wait behind work that is already late.
   */
  it('rejects with 503 and a Retry-After once the queue is full', async () => {
    const pool = buildPool({ size: 1, maxQueueDepth: 1, retryAfterSeconds: 7 });

    void pool.run('echo', 'running').catch(() => {});
    void pool.run('echo', 'queued').catch(() => {});
    await flush();

    const shed = pool.run('echo', 'shed');

    await expect(shed).rejects.toBeInstanceOf(WorkerQueueFullError);
    await expect(shed).rejects.toMatchObject({
      statusCode: 503,
      code: 'WORKER_QUEUE_FULL',
      headers: { 'Retry-After': '7' },
      queueDepth: 1,
    });
  });

  it('rejects immediately at maxQueueDepth 0 when every thread is busy', async () => {
    const pool = buildPool({ size: 1, maxQueueDepth: 0 });

    void pool.run('echo', 'running').catch(() => {});
    await flush();

    await expect(pool.run('echo', 'shed')).rejects.toBeInstanceOf(WorkerQueueFullError);
    expect(pool.stats().queued).toBe(0);
  });

  it('bounds tasks that are waiting, not tasks that are running', async () => {
    const pool = buildPool({ size: 2, maxQueueDepth: 1 });

    void pool.run('echo', 'a').catch(() => {});
    void pool.run('echo', 'b').catch(() => {});
    await flush();

    // Both threads are busy but nothing is waiting, so a third is admitted.
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 0 });
    void pool.run('echo', 'c').catch(() => {});
    await flush();
    expect(pool.stats().queued).toBe(1);

    await expect(pool.run('echo', 'd')).rejects.toBeInstanceOf(WorkerQueueFullError);
  });
});

describe('task timeouts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects with 504 and destroys the thread, which cannot be interrupted', async () => {
    const pool = buildPool({ size: 1, taskTimeoutMs: 500 });

    const result = pool.run('echo', 'wedged');
    await Promise.resolve();

    const worker = FakeWorker.instances[0];
    jest.advanceTimersByTime(500);

    await expect(result).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
    await expect(result).rejects.toMatchObject({ statusCode: 504, code: 'WORKER_TASK_TIMEOUT' });
    expect(worker?.terminateCount).toBe(1);
    expect(pool.stats().spawned).toBe(0);
  });

  it('spawns a replacement for the destroyed thread', async () => {
    const pool = buildPool({ size: 1, taskTimeoutMs: 500, maxQueueDepth: 2 });

    const wedged = pool.run('echo', 'wedged');
    await Promise.resolve();
    const queued = pool.run('echo', 'next');
    await Promise.resolve();

    jest.advanceTimersByTime(500);
    await expect(wedged).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
    await Promise.resolve();

    // The queued task must not be stranded by the loss of the only thread.
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1]?.succeed('NEXT');
    await expect(queued).resolves.toBe('NEXT');
  });

  it('honours a per-task timeout override', async () => {
    const pool = buildPool({ size: 1, taskTimeoutMs: 10_000 });

    const result = pool.run('echo', 'a', { timeoutMs: 100 });
    await Promise.resolve();

    jest.advanceTimersByTime(100);

    await expect(result).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
    // The *override* has to be what the error reports. Naming the pool default
    // here would tell a caller the one number the message exists to convey, and
    // tell it wrong.
    await expect(result).rejects.toMatchObject({ timeoutMs: 100 });
    await expect(result).rejects.toThrow('timed out after 100ms');
  });

  it('clears the timer when the task answers in time', async () => {
    const pool = buildPool({ size: 1, taskTimeoutMs: 500 });

    const result = pool.run('echo', 'a');
    await Promise.resolve();
    FakeWorker.instances[0]?.succeed('A');
    await expect(result).resolves.toBe('A');

    jest.advanceTimersByTime(5_000);

    expect(FakeWorker.instances[0]?.terminateCount).toBe(0);
  });
});

describe('a thread dying', () => {
  it('fails the task that was on it with 500, not with a timeout', async () => {
    const pool = buildPool({ size: 1 });

    const result = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.crash(new Error('segfault'));

    await expect(result).rejects.toBeInstanceOf(WorkerCrashedError);
    await expect(result).rejects.toMatchObject({
      statusCode: 500,
      code: 'WORKER_CRASHED',
      task: 'echo',
    });
  });

  it('keeps the cause, which is the only evidence of what happened', async () => {
    const pool = buildPool({ size: 1 });
    const cause = new Error('out of memory');

    const result = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.crash(cause);

    await expect(result).rejects.toMatchObject({ cause });
  });

  it('treats a clean exit mid-task as a loss too', async () => {
    const pool = buildPool({ size: 1 });

    const result = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.exit(0);

    await expect(result).rejects.toBeInstanceOf(WorkerCrashedError);
  });

  it('reports a death between tasks, where no caller can be told', async () => {
    const onWorkerError = jest.fn();
    const pool = buildPool({ size: 1, onWorkerError });

    const first = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.succeed('A');
    await first;

    FakeWorker.instances[0]?.crash(new Error('died while idle'));

    expect(onWorkerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'died while idle' }));
  });

  it('does not report the same death twice when error is followed by exit', async () => {
    const onWorkerError = jest.fn();
    const pool = buildPool({ size: 1, onWorkerError });

    const first = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.succeed('A');
    await first;

    // Node emits 'error' and then 'exit' for the same dead thread.
    FakeWorker.instances[0]?.crash(new Error('died'));
    FakeWorker.instances[0]?.exit(1);

    expect(onWorkerError).toHaveBeenCalledTimes(1);
  });

  it('replaces the dead thread on the next task', async () => {
    const pool = buildPool({ size: 1 });

    const first = pool.run('echo', 'a');
    await flush();
    FakeWorker.instances[0]?.crash(new Error('died'));
    await expect(first).rejects.toThrow();

    const second = pool.run('echo', 'b');
    await flush();

    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1]?.succeed('B');
    await expect(second).resolves.toBe('B');
  });
});

describe('drain', () => {
  it('resolves at once on a pool that never ran anything', async () => {
    const pool = buildPool();

    await expect(pool.drain()).resolves.toBeUndefined();
    expect(pool.stats().state).toBe('closed');
  });

  it('refuses new work while draining', async () => {
    const pool = buildPool({ size: 1 });

    void pool.run('echo', 'a').catch(() => {});
    await flush();

    const draining = pool.drain();
    const rejected = pool.run('echo', 'b');

    await expect(rejected).rejects.toBeInstanceOf(WorkerPoolClosedError);
    await expect(rejected).rejects.toMatchObject({ statusCode: 503, code: 'WORKER_POOL_CLOSED' });

    FakeWorker.instances[0]?.succeed('A');
    await draining;
  });

  /**
   * The distinction from `terminate()`. A queued task is a request whose client
   * is still waiting; discarding it would turn a rolling deploy into a burst of
   * 503s, which is the outage the deploy exists to avoid.
   */
  it('finishes queued work rather than discarding it, then terminates the threads', async () => {
    const pool = buildPool({ size: 1, maxQueueDepth: 3 });

    const first = pool.run('echo', 'first');
    const second = pool.run('echo', 'second');
    await flush();

    const worker = FakeWorker.instances[0];
    if (worker === undefined) throw new Error('expected a worker');

    const draining = pool.drain();
    expect(worker.terminateCount).toBe(0);

    worker.succeed('1');
    await expect(first).resolves.toBe('1');
    await flush();

    // The queued task was dispatched during the drain, not dropped.
    expect(worker.received[1]?.payload).toBe('second');
    worker.succeed('2');
    await expect(second).resolves.toBe('2');

    await draining;
    expect(worker.terminateCount).toBe(1);
    expect(pool.stats()).toMatchObject({ state: 'closed', spawned: 0 });
  });

  it('terminates idle threads too', async () => {
    const pool = buildPool({ size: 2, maxQueueDepth: 2 });

    const first = pool.run('echo', 'a');
    const second = pool.run('echo', 'b');
    await flush();
    FakeWorker.instances[0]?.succeed('A');
    FakeWorker.instances[1]?.succeed('B');
    await Promise.all([first, second]);

    await pool.drain();

    expect(FakeWorker.instances.map((w) => w.terminateCount)).toEqual([1, 1]);
  });

  it('is idempotent — concurrent and repeated calls await the same completion', async () => {
    const pool = buildPool({ size: 1 });

    const running = pool.run('echo', 'a');
    await flush();

    const a = pool.drain();
    const b = pool.drain();

    FakeWorker.instances[0]?.succeed('A');
    await running;
    await Promise.all([a, b]);

    expect(FakeWorker.instances[0]?.terminateCount).toBe(1);
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  it('completes even when the last thread dies rather than answering', async () => {
    const pool = buildPool({ size: 1 });

    const running = pool.run('echo', 'a');
    await flush();
    const draining = pool.drain();

    FakeWorker.instances[0]?.crash(new Error('died mid-drain'));
    await expect(running).rejects.toBeInstanceOf(WorkerCrashedError);

    await expect(draining).resolves.toBeUndefined();
    expect(pool.stats().state).toBe('closed');
  });
});

describe('terminate', () => {
  it('rejects queued and in-flight tasks instead of leaving them unsettled', async () => {
    const pool = buildPool({ size: 1, maxQueueDepth: 2 });

    const running = pool.run('echo', 'running');
    const queued = pool.run('echo', 'queued');
    await flush();

    await pool.terminate();

    await expect(running).rejects.toBeInstanceOf(WorkerPoolClosedError);
    await expect(queued).rejects.toBeInstanceOf(WorkerPoolClosedError);
    expect(FakeWorker.instances[0]?.terminateCount).toBe(1);
    expect(pool.stats()).toMatchObject({ state: 'closed', queued: 0, spawned: 0 });
  });

  it('refuses new work afterwards', async () => {
    const pool = buildPool();

    await pool.terminate();

    await expect(pool.run('echo', 'a')).rejects.toBeInstanceOf(WorkerPoolClosedError);
  });

  it('unblocks a drain that was waiting on a task that will never finish', async () => {
    const pool = buildPool({ size: 1 });

    const wedged = pool.run('echo', 'wedged');
    await flush();
    const draining = pool.drain();

    await pool.terminate();

    await expect(wedged).rejects.toBeInstanceOf(WorkerPoolClosedError);
    await expect(draining).resolves.toBeUndefined();
  });

  it('is idempotent', async () => {
    const pool = buildPool({ size: 1 });

    void pool.run('echo', 'a').catch(() => {});
    await flush();

    await pool.terminate();
    await pool.terminate();

    expect(FakeWorker.instances[0]?.terminateCount).toBe(1);
  });
});

describe('stats', () => {
  it('reports the shape of the pool as load moves through it', async () => {
    const pool = buildPool({ size: 2, maxQueueDepth: 4 });

    expect(pool.stats()).toEqual({
      state: 'open',
      size: 2,
      spawned: 0,
      busy: 0,
      queued: 0,
      maxQueueDepth: 4,
    });

    void pool.run('echo', 'a').catch(() => {});
    void pool.run('echo', 'b').catch(() => {});
    void pool.run('echo', 'c').catch(() => {});
    await flush();

    expect(pool.stats()).toMatchObject({ spawned: 2, busy: 2, queued: 1 });
  });
});
