import { defaultPoolSize } from '@/workers/cpu-pool';

describe('defaultPoolSize', () => {
  /**
   * One core is left for the event loop. Without the subtraction the main
   * thread competes for scheduling with N threads that never yield, so the
   * request that dispatched the work waits to be scheduled before it can send
   * its response — the pool would be adding the latency it exists to remove.
   */
  it('leaves a core for the event loop', () => {
    expect(defaultPoolSize(8)).toBe(7);
    expect(defaultPoolSize(2)).toBe(1);
  });

  /**
   * A container limited to a single CPU still has to be able to run the work.
   * A pool of zero would make every offloaded task wait forever — `acquireWorker`
   * can neither find an idle thread nor spawn one — so the floor is one thread
   * that shares the core, which is slower than not offloading but is not a hang.
   */
  it('never returns a pool that can run nothing', () => {
    expect(defaultPoolSize(1)).toBe(1);
    expect(defaultPoolSize(0)).toBe(1);
  });
});
