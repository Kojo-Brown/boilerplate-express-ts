import { withAbort } from '@/health/with-abort';
import type { DependencyCheck, DependencyCriticality } from '@/health/health.types';

/**
 * The part of `pg.Pool` this check uses, so the tests can drive a pool that
 * hangs, that hands back a broken client, or that answers after the deadline —
 * none of which a real Postgres can be asked for on demand.
 */
export interface HealthPoolClient {
  query(text: string): Promise<unknown>;
  /** `pg`'s own signature: an argument destroys the client instead of returning it. */
  release(destroy?: Error | boolean): void;
}

export interface HealthPool {
  connect(): Promise<HealthPoolClient>;
}

export interface PostgresCheckOptions {
  /**
   * A thunk, because `getPool()` constructs the pool on first call and a check
   * built at registration time would otherwise open a connection pool during
   * module loading.
   */
  readonly pool: () => HealthPool;
  readonly name?: string;
  readonly criticality?: DependencyCriticality;
}

/**
 * The cheapest question that still proves the whole path.
 *
 * Deliberately not a query against a table of ours: a readiness probe that
 * touches application data starts failing for reasons that are not
 * availability — a migration mid-flight, a lock held by a long transaction —
 * and each of those would take every replica out of the pool.
 */
export const POSTGRES_PING_SQL = 'SELECT 1';

/**
 * Readiness for Postgres, asked through the pool the application itself uses.
 *
 * ## Why the application's own pool
 *
 * A dedicated connection would be a more isolated measurement and a less useful
 * one. What a request needs is not "is the server up" but "can this process get
 * a client and get an answer", and those diverge in the case that matters most:
 * a pool exhausted by slow queries leaves the server perfectly healthy and this
 * instance unable to serve anything. A check on its own connection reports
 * `ok` throughout, which is a readiness probe that is green during an outage.
 *
 * The cost is the obvious one — under exhaustion the probe queues for a client
 * like everybody else, and enough probes would make it worse. That is bounded
 * at the other end, by the probe's deadline (the wait is given up, not held)
 * and by the single-flight and TTL in `createReadinessProbe` (there is at most
 * one of these in flight at a time, however many pollers are asking).
 *
 * ## The two releases
 *
 * Every path through this function releases exactly once, and the argument
 * differs on purpose. `release()` returns the client to the pool; `release(err)`
 * or `release(true)` destroys it. A client whose query failed, or whose query
 * outlived the probe's deadline, has unknown state on the wire — returning it
 * hands the next caller a connection that may still deliver a result the next
 * caller did not ask for.
 *
 * The third path is the one with nothing to release *yet*: the deadline expires
 * while `pool.connect()` is still queued. There is no way to withdraw that
 * request, so a client arrives later for a check that has already answered —
 * and the handler attached before the wait is what gives it back. Without it,
 * the pool loses a slot per timed-out probe, permanently, during the incident
 * where slots are what it has run out of.
 */
export function createPostgresCheck(options: PostgresCheckOptions): DependencyCheck {
  const { pool, name = 'postgres', criticality = 'critical' } = options;

  return {
    name,
    criticality,
    async run(signal: AbortSignal): Promise<void> {
      const pending = pool().connect();

      // Registered before anything awaits `pending`, so it is the first
      // continuation to run and therefore the one that sees the client first.
      // `signal.aborted` and not a flag of our own: the abort is a timer, so it
      // cannot fire between `pending` settling and this running, which makes
      // the flag an exact statement of whether anyone is still waiting.
      pending.then(
        (client) => {
          if (signal.aborted) client.release(true);
        },
        () => {
          // A failed connect has no client to release, and the rejection is
          // reported by the `withAbort` below — or, when the deadline won,
          // by nobody, which is the point of swallowing it here.
        },
      );

      const client = await withAbort(pending, signal);

      try {
        await client.query(POSTGRES_PING_SQL);
      } catch (error) {
        client.release(error instanceof Error ? error : true);
        throw error;
      }

      client.release(signal.aborted ? true : undefined);
    },
  };
}
