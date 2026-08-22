export type {
  SerializedError,
  TaskHandlers,
  TaskMap,
  TaskRequest,
  TaskResponse,
  TaskSignature,
} from '@/workers/protocol';
export { isTaskResponse, serializeError } from '@/workers/protocol';

export type { CpuTasks, DigestAlgorithm, DigestRequest, DigestResult } from '@/workers/cpu.tasks';
export { cpuTaskHandlers, DIGEST_ALGORITHMS, digest } from '@/workers/cpu.tasks';

export type { ResolveWorkerEntryOptions, WorkerEntry } from '@/workers/worker-entry';
export { cpuWorkerEntry, hasTypeScriptLoader, resolveWorkerEntry, TS_LOADER_ARGV } from '@/workers/worker-entry';

export {
  WorkerCrashedError,
  WorkerPoolClosedError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from '@/workers/pool.errors';

export type {
  PoolWorker,
  RunOptions,
  WorkerFactory,
  WorkerPoolOptions,
  WorkerPoolState,
  WorkerPoolStats,
} from '@/workers/worker-pool';
export { nodeWorkerFactory, WorkerPool } from '@/workers/worker-pool';

export { createCpuWorkerPool } from '@/workers/cpu-pool';
