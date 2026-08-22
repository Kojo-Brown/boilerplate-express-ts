import { Worker } from 'node:worker_threads';
import type { TransferListItem } from 'node:worker_threads';
import { isTaskResponse } from '@/workers/protocol';
import type { TaskMap, TaskRequest } from '@/workers/protocol';
import {
  WorkerCrashedError,
  WorkerPoolClosedError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '@/workers/pool.errors';
import type { WorkerEntry } from '@/workers/worker-entry';

/**
 * A fixed-size `worker_threads` pool with a bounded queue and a graceful drain.
 *
 * ## Why the queue is bounded
 *
 * An unbounded queue does not remove a limit, it hides one. Threads are the
 * real constraint — there are only so many cores — so work arriving faster than
 * it can be run has to go somewhere, and an unbounded array is the somewhere
 * that fails worst. Two things grow without limit: memory, because every queued
 * payload is retained (and these payloads are file-sized, which is why the work
 * is CPU-bound in the first place), and latency, because queue depth *is*
 * waiting time. Long before memory runs out, the pool is handing back results
 * to clients that gave up minutes ago, having spent real CPU computing them.
 *
 * A bound converts both into one honest, immediate answer: 503 with
 * `Retry-After`. Rejecting in microseconds while overloaded is what lets a load
 * balancer shed to another instance and lets a client retry deliberately, and
 * it keeps the tasks that *were* admitted fast instead of making everything
 * uniformly slow.
 *
 * ## Why a timeout destroys the thread
 *
 * There is no way to cancel a synchronous CPU task. That is not an omission in
 * this implementation — it is the defining property of the work: a tight loop
 * or a `createHash().update()` over 100 MiB has no yield point at which an
 * `AbortSignal` could be read. `Promise.race` would abandon the *result* while
 * the thread stayed pinned to the task forever, so the pool would lose a worker
 * per timeout and quietly starve.
 *
 * The only reclamation V8 offers is destroying the isolate, so a task timeout
 * terminates the worker and the pool spawns a replacement. It is expensive
 * (~30ms) and it is why `taskTimeoutMs` is a backstop for pathological input
 * rather than a routine deadline.
 *
 * ## What holds the event loop open
 *
 * Workers are `unref()`d and the per-task timer is not. Together those say
 * exactly the right thing: an idle pool never keeps a process alive, and a pool
 * with a task in flight always does. Getting either half wrong is a real bug —
 * ref'd workers keep a finished process hanging on threads nobody is waiting
 * for, and unref'ing the timer too would let a process exit out from under an
 * `await pool.run()`, leaving the promise permanently unsettled.
 *
 * ## Threads are spawned lazily
 *
 * Up to `size`, on demand, and never reaped. A pool that spawned eagerly would
 * charge every deployment N threads' worth of memory for a code path some of
 * them never take, and one that reaped idle threads would pay the ~30ms start
 * again on the next request after every lull — the workload this exists for
 * arrives in bursts, which is precisely when reaping is most likely to have
 * just happened.
 */

/**
 * The part of `worker_threads.Worker` the pool uses.
 *
 * An interface rather than the class so the pool's own behaviour — queueing,
 * bounding, timing out, replacing a dead thread, draining — can be driven by a
 * fake in a unit test, deterministically and in microseconds. `nodeWorkerFactory`
 * is the adapter that supplies the real thing, and
 * `worker-pool.integration.test.ts` is what stops that adapter from being the
 * untested seam this arrangement would otherwise create.
 */
export interface PoolWorker {
  postMessage(value: unknown, transferList?: readonly TransferListItem[]): void;
  /** The thread answered a task. */
  onMessage(listener: (value: unknown) => void): void;
  /** The thread threw where nothing could catch it. */
  onError(listener: (error: Error) => void): void;
  /** The thread ended, for any reason including a clean one. */
  onExit(listener: (exitCode: number) => void): void;
  terminate(): Promise<unknown>;
  unref(): void;
}

export type WorkerFactory = () => PoolWorker;

/**
 * Wraps a real `Worker` in the narrow shape above.
 *
 * Three named methods rather than one overloaded `on`, because the events this
 * pool reacts to are a closed set of exactly three, and spelling them out means
 * a fake in a test is an object literal that the compiler checks — no
 * `EventEmitter` to imitate and no cast anywhere in the seam.
 */
export function nodeWorkerFactory(entry: WorkerEntry): WorkerFactory {
  return () => {
    const worker = new Worker(
      entry.path,
      entry.execArgv === undefined ? undefined : { execArgv: [...entry.execArgv] },
    );

    return {
      postMessage: (value, transferList) => {
        // The readonly array is copied rather than cast: `postMessage` is free
        // to read its argument however it likes, and a cast would be asserting
        // something about Node's implementation this file cannot know.
        worker.postMessage(value, transferList === undefined ? undefined : [...transferList]);
      },
      onMessage: (listener) => {
        worker.on('message', listener);
      },
      onError: (listener) => {
        worker.on('error', listener);
      },
      onExit: (listener) => {
        worker.on('exit', listener);
      },
      terminate: () => worker.terminate(),
      unref: () => {
        worker.unref();
      },
    };
  };
}

export interface WorkerPoolOptions {
  /** Spawns one worker. */
  readonly createWorker: WorkerFactory;
  /** Maximum number of threads. Usually one per core, minus the event loop's. */
  readonly size: number;
  /**
   * How many tasks may wait for a thread before `run()` rejects.
   *
   * `0` is legal and means "no queue": a task that finds every thread busy is
   * refused at once. That is the right setting for work whose value expires
   * quickly, where waiting is never better than being told to try elsewhere.
   */
  readonly maxQueueDepth: number;
  /** Deadline per task, measured from dispatch rather than from `run()`. */
  readonly taskTimeoutMs: number;
  /** The `Retry-After` a `WorkerQueueFullError` advertises. Default `1`. */
  readonly retryAfterSeconds?: number;
  /**
   * Called when a thread dies with no task on it — a crash between tasks, which
   * no caller's promise can carry. Default: logs. Never rethrows, because there
   * is no request to fail and an unhandled throw from an event listener takes
   * the process down.
   */
  readonly onWorkerError?: (error: unknown) => void;
}

export interface RunOptions {
  /**
   * Objects to hand over rather than copy — `ArrayBuffer`s, `MessagePort`s.
   *
   * Zero-copy, and destructive: a transferred `ArrayBuffer` is **detached** in
   * this thread and every view onto it becomes zero-length. That makes it
   * unsafe for any buffer whose backing store is shared, which in Node is more
   * of them than it looks: `Buffer` allocations under 8 KiB are slices of a
   * shared pool, so transferring `small.buffer` detaches unrelated buffers that
   * happen to sit in the same allocation. Only transfer an `ArrayBuffer` this
   * code exclusively owns and will not touch again.
   */
  readonly transfer?: readonly TransferListItem[];
  /** Overrides `taskTimeoutMs` for this task. */
  readonly timeoutMs?: number;
}

export type WorkerPoolState = 'open' | 'draining' | 'closed';

export interface WorkerPoolStats {
  readonly state: WorkerPoolState;
  /** Configured maximum thread count. */
  readonly size: number;
  /** Threads actually spawned so far. */
  readonly spawned: number;
  /** Threads currently running a task. */
  readonly busy: number;
  /** Tasks waiting for a thread. */
  readonly queued: number;
  /** Configured queue bound. */
  readonly maxQueueDepth: number;
}

interface Settler {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface QueuedTask extends Settler {
  readonly task: string;
  readonly payload: unknown;
  readonly transfer: readonly TransferListItem[] | undefined;
  readonly timeoutMs: number;
}

interface InFlightTask extends Settler {
  readonly id: number;
  readonly task: string;
  readonly timer: NodeJS.Timeout;
  /**
   * The deadline this task was actually dispatched with.
   *
   * Carried per task rather than read back off the pool, because `RunOptions`
   * can override it: reporting `taskTimeoutMs` in the error would tell a caller
   * that used an override the wrong number, which is the one number the message
   * exists to convey.
   */
  readonly timeoutMs: number;
}

interface WorkerRecord {
  readonly worker: PoolWorker;
  current: InFlightTask | null;
  /** Set once the record has been removed from the pool, to keep retirement idempotent. */
  retired: boolean;
}

function defaultOnWorkerError(error: unknown): void {
  console.error('[worker pool] worker thread failed between tasks:', error);
}

export class WorkerPool<TTasks extends TaskMap> {
  private readonly createWorker: WorkerFactory;
  private readonly size: number;
  private readonly maxQueueDepth: number;
  private readonly taskTimeoutMs: number;
  private readonly retryAfterSeconds: number;
  private readonly onWorkerError: (error: unknown) => void;

  private readonly workers = new Set<WorkerRecord>();
  private readonly idle: WorkerRecord[] = [];
  private readonly queue: QueuedTask[] = [];

  private state: WorkerPoolState = 'open';
  private nextTaskId = 1;
  private drained: Promise<void> | null = null;
  private resolveDrained: (() => void) | null = null;

  constructor(options: WorkerPoolOptions) {
    const {
      createWorker,
      size,
      maxQueueDepth,
      taskTimeoutMs,
      retryAfterSeconds = 1,
      onWorkerError = defaultOnWorkerError,
    } = options;

    // Thrown at construction rather than on the first task: a pool configured
    // with a nonsense size should fail the process at boot, where it is
    // attributable, not under the load that first reveals it.
    assertPositiveInteger('size', size);
    assertNonNegativeInteger('maxQueueDepth', maxQueueDepth);
    assertPositiveInteger('taskTimeoutMs', taskTimeoutMs);
    assertPositiveInteger('retryAfterSeconds', retryAfterSeconds);

    this.createWorker = createWorker;
    this.size = size;
    this.maxQueueDepth = maxQueueDepth;
    this.taskTimeoutMs = taskTimeoutMs;
    this.retryAfterSeconds = retryAfterSeconds;
    this.onWorkerError = onWorkerError;
  }

  /**
   * Runs one task on a thread, resolving with its result.
   *
   * Admission is decided synchronously and in this order — a free thread, then
   * a queue slot, then rejection — so a caller learns it has been shed before
   * it awaits anything. The bound is checked against tasks *waiting*, not tasks
   * outstanding: work on a thread is progressing and is not what the limit is
   * protecting.
   */
  run<K extends keyof TTasks & string>(
    task: K,
    payload: TTasks[K]['payload'],
    options: RunOptions = {},
  ): Promise<TTasks[K]['result']> {
    const { transfer, timeoutMs = this.taskTimeoutMs } = options;

    return new Promise<TTasks[K]['result']>((resolve, reject) => {
      const settler: Settler = {
        resolve: (value) => {
          resolve(value as TTasks[K]['result']);
        },
        reject,
      };

      if (this.state !== 'open') {
        reject(new WorkerPoolClosedError(this.state));
        return;
      }

      const worker = this.acquireWorker();

      if (worker !== null) {
        this.dispatch(worker, { task, payload, transfer, timeoutMs, ...settler });
        return;
      }

      if (this.queue.length >= this.maxQueueDepth) {
        reject(new WorkerQueueFullError(this.queue.length, this.retryAfterSeconds));
        return;
      }

      this.queue.push({ task, payload, transfer, timeoutMs, ...settler });
    });
  }

  stats(): WorkerPoolStats {
    let busy = 0;
    for (const record of this.workers) {
      if (record.current !== null) busy += 1;
    }

    return {
      state: this.state,
      size: this.size,
      spawned: this.workers.size,
      busy,
      queued: this.queue.length,
      maxQueueDepth: this.maxQueueDepth,
    };
  }

  /**
   * Stops accepting work, lets everything already accepted finish, then
   * terminates the threads.
   *
   * The queue is *drained*, not discarded, and that is the whole distinction
   * from `terminate()`. A queued task represents a request whose client is
   * still waiting; throwing it away during a rolling deploy turns every
   * in-flight request on every replaced instance into a 503, which is the
   * outage the deploy was supposed to avoid.
   *
   * Threads keep being spawned while draining if the queue still holds work and
   * a worker was lost — without that, a task that timed out at the wrong moment
   * would leave the remaining queue with nothing to run it on and the drain
   * would never finish.
   *
   * Idempotent: concurrent and repeated calls await the same completion.
   */
  drain(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();

    if (this.drained === null) {
      this.state = 'draining';
      this.drained = new Promise<void>((resolve) => {
        this.resolveDrained = resolve;
      });
      // A pool that is already quiet — or was never used — completes here
      // rather than waiting for an event that has no reason to arrive.
      this.settleDrainIfIdle();
    }

    return this.drained;
  }

  /**
   * Immediate shutdown: every queued and in-flight task is rejected and every
   * thread is destroyed.
   *
   * The escape hatch for when a drain will not finish — a task wedged in an
   * infinite loop with a timeout longer than the shutdown grace period. Callers
   * are rejected rather than left hanging, because a promise that never settles
   * during shutdown is how a process ends up killed by SIGKILL with its logs
   * saying nothing.
   */
  async terminate(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';

    for (const queued of this.queue.splice(0)) {
      queued.reject(new WorkerPoolClosedError('closed'));
    }

    const records = [...this.workers];
    for (const record of records) {
      const current = record.current;
      record.current = null;
      if (current !== null) {
        clearTimeout(current.timer);
        current.reject(new WorkerPoolClosedError('closed'));
      }
    }

    await this.destroyAll(records);
    this.resolveDrainedIfPending();
  }

  // --- internals -----------------------------------------------------------

  /** An idle worker, a newly spawned one, or `null` when at capacity. */
  private acquireWorker(): WorkerRecord | null {
    const idle = this.idle.pop();
    if (idle !== undefined) return idle;
    if (this.workers.size >= this.size) return null;
    return this.spawn();
  }

  private spawn(): WorkerRecord {
    const worker = this.createWorker();
    const record: WorkerRecord = { worker, current: null, retired: false };

    worker.onMessage((value: unknown) => {
      this.onMessage(record, value);
    });
    worker.onError((error: Error) => {
      this.onWorkerFailure(record, error);
    });
    worker.onExit((code: number) => {
      // A clean `exit` still fails whatever was on the thread: the task was
      // meant to answer with a message and did not. `process.exit()` inside a
      // task is the realistic way here, and code 0 makes it no less of a loss.
      this.onWorkerFailure(record, new Error(`worker exited with code ${code}`));
    });

    // See the class comment: the pool must not be the reason a process stays
    // alive. The per-task timer, which is *not* unref'd, is what keeps it alive
    // for exactly as long as a task is outstanding.
    worker.unref();

    this.workers.add(record);
    return record;
  }

  private dispatch(record: WorkerRecord, queued: QueuedTask): void {
    const id = this.nextTaskId++;

    const timer = setTimeout(() => {
      this.onTimeout(record, id);
    }, queued.timeoutMs);

    record.current = {
      id,
      task: queued.task,
      timer,
      timeoutMs: queued.timeoutMs,
      resolve: queued.resolve,
      reject: queued.reject,
    };

    const request: TaskRequest = {
      kind: 'task',
      id,
      task: queued.task,
      payload: queued.payload,
    };

    try {
      record.worker.postMessage(request, queued.transfer);
    } catch (err) {
      // A payload the structured clone algorithm refuses (a function, a class
      // instance with a getter that throws) fails *here*, synchronously, before
      // the thread has seen anything. The thread is therefore fine and is
      // returned to the pool; only the caller fails.
      clearTimeout(timer);
      record.current = null;
      queued.reject(err);
      this.release(record);
    }
  }

  private onMessage(record: WorkerRecord, value: unknown): void {
    if (!isTaskResponse(value)) return;

    const current = record.current;
    // A response whose id does not match the task on this worker is late: its
    // task already timed out and its caller has already been rejected. Settling
    // on it would resolve a promise that is no longer this one's, so it is
    // dropped. (The pool terminates a timed-out worker, so this is a narrow
    // race rather than a routine path — but it is reachable.)
    if (current === null || current.id !== value.id) return;

    clearTimeout(current.timer);
    record.current = null;

    if (value.ok) {
      current.resolve(value.value);
    } else {
      current.reject(new WorkerTaskError(current.task, value.error));
    }

    this.release(record);
  }

  private onTimeout(record: WorkerRecord, id: number): void {
    const current = record.current;
    if (current === null || current.id !== id) return;

    record.current = null;
    current.reject(new WorkerTaskTimeoutError(current.task, current.timeoutMs));

    // The thread cannot be reclaimed, only destroyed — see the class comment.
    void this.retire(record);
  }

  private onWorkerFailure(record: WorkerRecord, error: unknown): void {
    if (record.retired) return;

    const current = record.current;
    record.current = null;

    if (current !== null) {
      clearTimeout(current.timer);
      current.reject(new WorkerCrashedError(current.task, error));
    } else {
      // Nothing was running, so no caller can be told. Reported rather than
      // swallowed: a thread that dies repeatedly between tasks is a crash loop,
      // and the only place it is visible is here.
      this.onWorkerError(error);
    }

    void this.retire(record);
  }

  /** Removes a worker from rotation and destroys it. Idempotent. */
  private async retire(record: WorkerRecord): Promise<void> {
    if (record.retired) return;
    record.retired = true;

    this.workers.delete(record);
    const index = this.idle.indexOf(record);
    if (index !== -1) this.idle.splice(index, 1);

    // Queued work may now be able to run on a replacement thread, and a drain
    // may have just become complete — whichever applies.
    this.pump();
    this.settleDrainIfIdle();

    try {
      await record.worker.terminate();
    } catch (err) {
      // `terminate()` rejecting on an already-dead thread is not a failure of
      // anything: the thread is gone, which is what was asked for.
      this.onWorkerError(err);
    }
  }

  /** Returns a finished worker to rotation and starts the next queued task. */
  private release(record: WorkerRecord): void {
    if (record.retired) return;

    if (this.state === 'closed') {
      void this.retire(record);
      return;
    }

    this.idle.push(record);
    this.pump();
    this.settleDrainIfIdle();
  }

  /** Dispatches queued tasks while there is anywhere to put them. */
  private pump(): void {
    while (this.queue.length > 0 && this.state !== 'closed') {
      const worker = this.acquireWorker();
      if (worker === null) return;

      const queued = this.queue.shift();
      // Unreachable — the loop condition just checked the length — but
      // `noUncheckedIndexedAccess` is right to insist, and putting the worker
      // back is the only correct thing to do with it if it ever happened.
      if (queued === undefined) {
        this.idle.push(worker);
        return;
      }

      this.dispatch(worker, queued);
    }
  }

  private settleDrainIfIdle(): void {
    if (this.state !== 'draining') return;
    if (this.queue.length > 0) return;
    for (const record of this.workers) {
      if (record.current !== null) return;
    }

    this.state = 'closed';
    const records = [...this.workers];
    void this.destroyAll(records).then(() => {
      this.resolveDrainedIfPending();
    });
  }

  private async destroyAll(records: readonly WorkerRecord[]): Promise<void> {
    this.workers.clear();
    this.idle.length = 0;

    await Promise.all(
      records.map(async (record) => {
        if (record.retired) return;
        record.retired = true;
        try {
          await record.worker.terminate();
        } catch (err) {
          this.onWorkerError(err);
        }
      }),
    );
  }

  private resolveDrainedIfPending(): void {
    const resolve = this.resolveDrained;
    if (resolve === null) return;
    this.resolveDrained = null;
    resolve();
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `WorkerPool: ${name} must be a positive integer, received ${String(value)}`,
    );
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `WorkerPool: ${name} must be a non-negative integer, received ${String(value)}`,
    );
  }
}
