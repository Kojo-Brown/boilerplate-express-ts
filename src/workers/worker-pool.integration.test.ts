import { createHash, randomBytes } from 'node:crypto';
import { WorkerTaskError, WorkerTaskTimeoutError } from '@/workers/pool.errors';
import type { CpuTasks } from '@/workers/cpu.tasks';
import { cpuWorkerEntry } from '@/workers/worker-entry';
import { nodeWorkerFactory, WorkerPool } from '@/workers/worker-pool';

/**
 * Real `worker_threads`, real message passing, the real entry point.
 *
 * `worker-pool.test.ts` drives the pool through a fake worker, which is the
 * right way to test scheduling but leaves the most failure-prone part of this
 * feature completely uncovered: whether a thread can be started at all. That
 * seam — `cpuWorkerEntry()` resolving a path, `nodeWorkerFactory` handing it to
 * `new Worker`, the entry loading its own graph without the `@/` alias, and
 * both sides agreeing on the protocol — is exactly what a fake cannot check and
 * exactly what breaks on a rename, a `rootDir` change or a stray aliased
 * import.
 *
 * Under jest the entry resolves to `cpu.worker.ts` and the thread is given
 * `--require ts-node/register/transpile-only`, because jest's transform is a
 * property of its own module registry and does not cross a thread boundary.
 * Under `node dist/` it resolves to `cpu.worker.js` and needs no loader. Both
 * paths are `resolveWorkerEntry`'s job; this suite proves the one it can reach.
 */

// Starting a thread and compiling its graph through ts-node costs a few hundred
// milliseconds — comfortably inside this, and far outside jest's 5s default.
jest.setTimeout(30_000);

function buildPool(overrides: { size?: number; taskTimeoutMs?: number } = {}): WorkerPool<CpuTasks> {
  return new WorkerPool<CpuTasks>({
    createWorker: nodeWorkerFactory(cpuWorkerEntry()),
    size: overrides.size ?? 2,
    maxQueueDepth: 8,
    taskTimeoutMs: overrides.taskTimeoutMs ?? 20_000,
    onWorkerError: () => {},
  });
}

describe('WorkerPool over real worker threads', () => {
  let pool: WorkerPool<CpuTasks>;

  afterEach(async () => {
    await pool.terminate();
  });

  it('starts a thread and returns a digest that matches this thread', async () => {
    pool = buildPool({ size: 1 });
    const bytes = randomBytes(256 * 1024);

    const result = await pool.run('digest', { algorithm: 'sha256', bytes });

    expect(result).toEqual({
      algorithm: 'sha256',
      hex: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    });
  });

  it('carries a Buffer across as a Uint8Array that hashes the same', async () => {
    pool = buildPool({ size: 1 });
    const bytes = randomBytes(64 * 1024);

    const viaWorker = await pool.run('digest', { algorithm: 'sha512', bytes });

    expect(viaWorker.hex).toBe(createHash('sha512').update(bytes).digest('hex'));
  });

  it('runs tasks concurrently across threads and keeps every result with its caller', async () => {
    pool = buildPool({ size: 2 });
    const payloads = Array.from({ length: 8 }, () => randomBytes(64 * 1024));

    const results = await Promise.all(
      payloads.map((bytes) => pool.run('digest', { algorithm: 'sha256', bytes })),
    );

    // The correlation check: eight tasks over two threads must not cross their
    // answers, which is the failure a shared message port makes easy to write.
    results.forEach((result, index) => {
      const expected = createHash('sha256')
        .update(payloads[index] as Uint8Array)
        .digest('hex');
      expect(result.hex).toBe(expected);
    });
    expect(new Set(results.map((r) => r.hex)).size).toBe(8);
  });

  it('propagates a task failure as a WorkerTaskError without killing the thread', async () => {
    pool = buildPool({ size: 1 });

    // `digest` validates its algorithm at runtime, so this is a real throw
    // inside the worker rather than a contrived one. The cast stands in for a
    // value the compiler could not see — see `cpu.tasks.test.ts`.
    const bad = pool.run('digest', {
      algorithm: 'md5' as 'sha256',
      bytes: new Uint8Array(8),
    });

    await expect(bad).rejects.toBeInstanceOf(WorkerTaskError);
    await expect(bad).rejects.toMatchObject({
      remoteName: 'TypeError',
      message: expect.stringContaining('unsupported algorithm'),
    });

    // The thread is healthy: a failed task is not a failed worker.
    const good = await pool.run('digest', { algorithm: 'sha256', bytes: new Uint8Array(8) });
    expect(good.byteLength).toBe(8);
    expect(pool.stats().spawned).toBe(1);
  });

  it('answers an unknown task name instead of stranding the caller', async () => {
    pool = buildPool({ size: 1 });

    // Deliberately outside `CpuTasks`; the cast is what a JavaScript caller or a
    // stale deployment would do accidentally.
    const unknown = (pool as WorkerPool<CpuTasks & { nope: { payload: null; result: never } }>).run(
      'nope',
      null,
    );

    await expect(unknown).rejects.toMatchObject({ code: 'UNKNOWN_WORKER_TASK' });
  });

  it('drains: queued work finishes and every thread is gone afterwards', async () => {
    pool = buildPool({ size: 2 });
    const payloads = Array.from({ length: 6 }, () => randomBytes(32 * 1024));

    const running = payloads.map((bytes) => pool.run('digest', { algorithm: 'sha256', bytes }));
    const draining = pool.drain();

    const results = await Promise.all(running);
    await draining;

    expect(results).toHaveLength(6);
    results.forEach((result, index) => {
      expect(result.hex).toBe(
        createHash('sha256')
          .update(payloads[index] as Uint8Array)
          .digest('hex'),
      );
    });
    expect(pool.stats()).toMatchObject({ state: 'closed', spawned: 0 });
  });

  /**
   * The claim that most deserves a real thread behind it: a synchronous CPU
   * task cannot be cancelled, so the pool's only remedy is to destroy the
   * isolate. A fake worker can be *told* it was terminated; only a real one
   * shows what termination actually costs.
   *
   * And it costs more than it looks. `worker.terminate()` stops the isolate at
   * a JavaScript boundary — it cannot interrupt a call that is currently down
   * inside native code, and `createHash().update()` over a large buffer is
   * exactly that: one call into OpenSSL with no yield point anywhere in it. The
   * thread therefore keeps running, and keeps holding a core, until that call
   * returns of its own accord.
   *
   * Which is a real operational property rather than a curiosity: between a
   * timeout and the wedged thread's actual exit, the process runs **more than
   * `size` threads**. The pool is right not to wait — the replacement is what
   * keeps requests being served — but a `taskTimeoutMs` tuned so low that
   * timeouts are routine would stack overlapping zombie threads and make the
   * saturation worse. This asserts both halves: the pool recovers immediately,
   * and the thread does eventually go.
   */
  it('replaces a thread wedged in an uninterruptible task before that thread exits', async () => {
    const exits: Promise<number>[] = [];
    const factory = nodeWorkerFactory(cpuWorkerEntry());

    pool = new WorkerPool<CpuTasks>({
      createWorker: () => {
        const worker = factory();
        exits.push(
          new Promise<number>((resolve) => {
            worker.onExit(resolve);
          }),
        );
        return worker;
      },
      size: 1,
      maxQueueDepth: 4,
      taskTimeoutMs: 20_000,
      onWorkerError: () => {},
    });

    // Warm the thread up first, and put the short deadline on the wedging task
    // alone. A pool-wide 200ms would be spent on thread startup — spawning plus
    // compiling the entry's graph through ts-node is a few hundred milliseconds
    // — and the test would then be timing the wrong thing entirely.
    await pool.run('digest', { algorithm: 'sha256', bytes: new Uint8Array(4) });

    // ~480ms of SHA-512 on this machine, against a 100ms deadline, on a thread
    // that is already running. The margin is deliberately wide in the direction
    // that could go flaky: a CI runner would have to hash almost five times
    // faster than this machine for the task to beat its deadline. The other
    // direction is safe by construction — a slower runner only overruns harder,
    // and the clock starts at dispatch, so the structured-clone copy of the
    // payload is inside the deadline rather than ahead of it.
    const wedged = pool.run(
      'digest',
      { algorithm: 'sha512', bytes: new Uint8Array(256 * 1024 * 1024) },
      { timeoutMs: 100 },
    );

    await expect(wedged).rejects.toBeInstanceOf(WorkerTaskTimeoutError);
    await expect(wedged).rejects.toMatchObject({ statusCode: 504 });

    // A replacement is spawned on demand and the pool keeps serving — while the
    // first thread is, in all likelihood, still hashing.
    const after = await pool.run('digest', { algorithm: 'sha256', bytes: new Uint8Array(4) });
    expect(after.byteLength).toBe(4);
    expect(exits).toHaveLength(2);

    // Awaited rather than assumed, so the thread cannot outlive this suite and
    // be reported as a leaked handle by a later one.
    await exits[0];
  });
});
