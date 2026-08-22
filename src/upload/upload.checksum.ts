import type { CpuTasks, DigestAlgorithm, DigestResult } from '@/workers/cpu.tasks';
import { digest } from '@/workers/cpu.tasks';
import type { WorkerPool } from '@/workers/worker-pool';

/**
 * The content digest returned with a stored upload — and the one place that
 * decides whether computing it is worth a thread.
 *
 * This is the pool's reason to exist in this codebase. Hashing an upload is
 * genuinely CPU-bound (`createHash` never yields, ~1–2 GB/s), genuinely useful
 * (a client can verify what was stored, and a duplicate is detectable without
 * re-reading the object), and genuinely proportional to input the caller
 * controls — which is the combination that turns a fast operation into an
 * event-loop stall under load.
 */

export const DEFAULT_CHECKSUM_ALGORITHM: DigestAlgorithm = 'sha256';

export interface ChecksumOptions {
  readonly pool: WorkerPool<CpuTasks>;
  /**
   * Payloads smaller than this are hashed inline instead.
   *
   * A threshold rather than "always offload", because offloading is not free
   * and below some size it is a straight loss: a task costs a structured-clone
   * copy of the payload in each direction plus two event-loop hops, on the
   * order of 100µs, to avoid a stall that for a 4 KiB body is around 3µs. The
   * pool would be making the common request slower in order to protect the
   * event loop from something that was never going to block it.
   *
   * The default (64 KiB, `WORKER_POOL_OFFLOAD_MIN_BYTES`) sits an order of
   * magnitude above the break-even point rather than at it: near the crossover
   * the two paths cost the same, so there is nothing to win by being precise
   * and a mis-estimate on slower hardware costs latency in the direction that
   * matters.
   */
  readonly offloadMinBytes: number;
  readonly algorithm?: DigestAlgorithm;
}

export interface ChecksumOutcome extends DigestResult {
  /** `'worker'` when a thread ran it, `'inline'` when it was below the threshold. */
  readonly computedOn: 'worker' | 'inline';
}

/**
 * Hashes `bytes`, on a worker thread when that is the cheaper option.
 *
 * Nothing is transferred, and that is deliberate rather than an optimisation
 * left on the table. Transferring would detach the `ArrayBuffer` in this
 * thread, and the buffer here comes from Multer: allocations under 8 KiB are
 * *slices of a shared pool*, so `bytes.buffer` is routinely backing store that
 * other live buffers also point into. Transferring it would zero-length them,
 * at a distance, non-deterministically by size — and the caller still needs
 * these bytes afterwards to store the object. A copy of a payload that is by
 * definition already large enough to be worth a thread is the right trade.
 */
export async function computeChecksum(
  bytes: Uint8Array,
  options: ChecksumOptions,
): Promise<ChecksumOutcome> {
  const { pool, offloadMinBytes, algorithm = DEFAULT_CHECKSUM_ALGORITHM } = options;

  if (bytes.byteLength < offloadMinBytes) {
    return { ...digest({ algorithm, bytes }), computedOn: 'inline' };
  }

  const result = await pool.run('digest', { algorithm, bytes });
  return { ...result, computedOn: 'worker' };
}
