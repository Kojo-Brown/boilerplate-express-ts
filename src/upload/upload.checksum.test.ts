import { createHash, randomBytes } from 'node:crypto';
import { computeChecksum } from '@/upload/upload.checksum';
import type { CpuTasks } from '@/workers/cpu.tasks';
import { digest } from '@/workers/cpu.tasks';
import { WorkerQueueFullError } from '@/workers/pool.errors';
import type { WorkerPool } from '@/workers/worker-pool';

/**
 * A pool stand-in that records what it was asked to do.
 *
 * The decision under test is *whether* to use a thread, so what matters is
 * whether `run` was called — not what a real thread would have returned. The
 * fake computes the same digest the worker would, so the offloaded and inline
 * paths can be asserted to agree.
 */
function fakePool(): { pool: WorkerPool<CpuTasks>; calls: number } {
  const state = { calls: 0 };
  const pool = {
    run: (_task: 'digest', payload: CpuTasks['digest']['payload']) => {
      state.calls += 1;
      return Promise.resolve(digest(payload));
    },
  };

  return {
    pool: pool as unknown as WorkerPool<CpuTasks>,
    get calls(): number {
      return state.calls;
    },
  };
}

describe('computeChecksum', () => {
  it('hashes inline below the threshold, without touching the pool', async () => {
    const fake = fakePool();
    const bytes = randomBytes(1024);

    const result = await computeChecksum(bytes, { pool: fake.pool, offloadMinBytes: 65_536 });

    expect(result).toEqual({
      algorithm: 'sha256',
      hex: createHash('sha256').update(bytes).digest('hex'),
      byteLength: 1024,
      computedOn: 'inline',
    });
    expect(fake.calls).toBe(0);
  });

  it('offloads at or above the threshold', async () => {
    const fake = fakePool();
    const bytes = randomBytes(65_536);

    const result = await computeChecksum(bytes, { pool: fake.pool, offloadMinBytes: 65_536 });

    expect(result.computedOn).toBe('worker');
    expect(fake.calls).toBe(1);
  });

  // The boundary is `<`, so the threshold byte itself offloads. Pinned because
  // an off-by-one here is invisible in production — both paths return the same
  // digest — and would only ever show up as a latency change nobody could
  // attribute.
  it('treats the threshold as inclusive of the worker path', async () => {
    const below = fakePool();
    await computeChecksum(randomBytes(65_535), { pool: below.pool, offloadMinBytes: 65_536 });
    expect(below.calls).toBe(0);

    const at = fakePool();
    await computeChecksum(randomBytes(65_536), { pool: at.pool, offloadMinBytes: 65_536 });
    expect(at.calls).toBe(1);
  });

  /**
   * The property that makes the threshold safe to tune: moving it changes
   * latency and nothing else. If the two paths could disagree, the digest a
   * client verified against would depend on a deployment's configuration.
   */
  it('produces the same digest either side of the threshold', async () => {
    const bytes = randomBytes(32_768);

    const inline = await computeChecksum(bytes, { pool: fakePool().pool, offloadMinBytes: 65_536 });
    const offloaded = await computeChecksum(bytes, { pool: fakePool().pool, offloadMinBytes: 1 });

    expect(inline.computedOn).toBe('inline');
    expect(offloaded.computedOn).toBe('worker');
    expect(inline.hex).toBe(offloaded.hex);
  });

  it('honours a non-default algorithm', async () => {
    const bytes = randomBytes(128);

    const result = await computeChecksum(bytes, {
      pool: fakePool().pool,
      offloadMinBytes: 65_536,
      algorithm: 'sha512',
    });

    expect(result.algorithm).toBe('sha512');
    expect(result.hex).toBe(createHash('sha512').update(bytes).digest('hex'));
  });

  it('hashes an empty buffer inline rather than dispatching a task for nothing', async () => {
    const fake = fakePool();

    const result = await computeChecksum(new Uint8Array(0), {
      pool: fake.pool,
      offloadMinBytes: 65_536,
    });

    expect(result.byteLength).toBe(0);
    expect(fake.calls).toBe(0);
  });

  /**
   * Backpressure has to reach the caller. Swallowing this and falling back to
   * hashing inline would put the CPU work back on the event loop at exactly the
   * moment the pool is saying the machine has none to spare — turning load
   * shedding into the stall it exists to prevent.
   */
  it('propagates a shed task rather than falling back to the event loop', async () => {
    const saturated = {
      run: () => Promise.reject(new WorkerQueueFullError(64, 1)),
    } as unknown as WorkerPool<CpuTasks>;

    await expect(
      computeChecksum(randomBytes(65_536), { pool: saturated, offloadMinBytes: 65_536 }),
    ).rejects.toBeInstanceOf(WorkerQueueFullError);
  });
});
