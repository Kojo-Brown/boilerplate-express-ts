import { availableParallelism } from 'node:os';
import { env } from '@/config/env';
import type { CpuTasks } from '@/workers/cpu.tasks';
import { cpuWorkerEntry } from '@/workers/worker-entry';
import { nodeWorkerFactory, WorkerPool } from '@/workers/worker-pool';

/**
 * The pool this service actually runs, configured from the environment.
 *
 * Separate from `WorkerPool` so the class stays a library — every knob passed
 * in, no import of `env`, testable without a process — and so there is exactly
 * one place that turns configuration into a pool.
 */

/**
 * How many threads `WORKER_POOL_SIZE=0` means.
 *
 * `availableParallelism() - 1`, floored at one. The subtraction is the event
 * loop's own core: a pool sized to every core makes the main thread compete
 * with N threads that never yield, so the request that *dispatched* the work
 * waits to be scheduled before it can send the response — the pool would then
 * be adding the latency it exists to remove.
 *
 * `availableParallelism()` rather than `cpus().length`, because it honours the
 * cgroup CPU quota a container is actually limited to. `cpus().length` reports
 * the host's cores, so a 0.5-CPU pod reads 64 and sizes a 63-thread pool.
 */
export function defaultPoolSize(parallelism: number = availableParallelism()): number {
  return Math.max(1, parallelism - 1);
}

export function createCpuWorkerPool(): WorkerPool<CpuTasks> {
  return new WorkerPool<CpuTasks>({
    createWorker: nodeWorkerFactory(cpuWorkerEntry()),
    size: env.WORKER_POOL_SIZE === 0 ? defaultPoolSize() : env.WORKER_POOL_SIZE,
    maxQueueDepth: env.WORKER_POOL_MAX_QUEUE_DEPTH,
    taskTimeoutMs: env.WORKER_POOL_TASK_TIMEOUT_MS,
    retryAfterSeconds: env.WORKER_POOL_RETRY_AFTER_SECONDS,
  });
}
