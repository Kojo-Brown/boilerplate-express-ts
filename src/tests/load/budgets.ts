/**
 * The load profile's request names, its ceilings, and the scenario that
 * produces them. One file, imported by all three halves of the gate: the k6
 * profile (`script.ts`), the runner (`run.ts`) and the gate
 * (`check-budget.ts`).
 *
 * It imports nothing. That is deliberate and it is what makes the arrangement
 * work: `script.ts` is executed by k6's own runtime, where `node:*` does not
 * exist, and `check-budget.ts` is executed by Node, where `k6/http` does not.
 * A single source of truth for the names can only be a module that needs
 * neither.
 *
 * See `docs/load-testing.md`.
 */

/**
 * Every request name the profile may produce, and therefore every row the gate
 * gates on.
 *
 * This is the one list, and the type below is what keeps it the one list. The
 * profile's task table is declared as `Record<LoadRequestName, …>`, so a task
 * added without a name here does not compile, and a name here without a task
 * does not compile either. The equivalent arrangement in
 * `boilerplate-python-fastapi` is an import direction — the locustfile imports
 * its task names from the gate — which achieves the same thing by convention;
 * this achieves it by typecheck.
 *
 * The strings are what k6 puts in the `name` tag, so they are also what appears
 * in the summary, in the gate's table, and in a red job's log. They are spelled
 * like the request a reader would make by hand.
 */
export const LOAD_REQUEST_NAMES = [
  'GET /v1/health/live',
  'GET /v1/health/ready',
  'GET /v1/users/:id (cached)',
  'GET /v1/users/:id (uncached)',
  'GET /v1/users/:id (If-None-Match)',
] as const;

export type LoadRequestName = (typeof LOAD_REQUEST_NAMES)[number];

export interface LoadBudget {
  /**
   * The 95th-percentile ceiling in milliseconds, as measured by k6 —
   * `http_req_duration`, which is the whole exchange minus the connect and TLS
   * phases of the first request on a connection.
   *
   * These are regression bounds and not an SLO: each is ten to fifteen times
   * the worst measurement in the table in `docs/load-testing.md`, which was
   * taken on a developer machine whose other cores were busy. They are
   * deliberately *not* tightened to the CI column, which is two to three times
   * quicker — pinned there the ceilings would be around 2ms and the gate would
   * fire on anyone with a build running in another terminal. The multiple is
   * what that spread costs, not a number anybody liked.
   *
   * Lowering one to turn a red build green is the single move this gate exists
   * to prevent. If a change genuinely makes a path slower and that is
   * acceptable, raise the ceiling in the same commit, with the measurement and
   * the reason.
   */
  readonly p95Ms: number;
  /**
   * The fewest requests this name may be measured over before the gate refuses
   * to believe the percentile.
   *
   * A p95 over thirty samples is not a p95. The scenario below drives exactly
   * one request per name per iteration, so every name should land on
   * `iterationsPerSecond * durationSeconds`; the floor sits under that by
   * enough to absorb the ramp at either end of the run and nothing more.
   */
  readonly minRequests: number;
}

/**
 * What each ceiling is a ceiling on. The comments are the profile's
 * documentation — `script.ts` builds the requests, but what each one is *for*
 * belongs next to the number that gates it.
 */
export const LOAD_BUDGETS: Readonly<Record<LoadRequestName, LoadBudget>> = {
  /**
   * The middleware stack and nothing else: security headers, the metrics timer,
   * CORS, the webhook raw-body branch, both body parsers, `session()`,
   * passport, the correlation id, the trace context, the access logger, the
   * container scope, the shutdown guard, two routers, and a handler that
   * returns a constant. No authentication, no database, no cache.
   *
   * It is the floor the other four are read against. A middleware added to
   * `createApp` shows up here first and most clearly, which is the whole reason
   * a route that does nothing is in the profile.
   */
  'GET /v1/health/live': { p95Ms: 25, minRequests: 1500 },

  /**
   * A live round trip to Postgres on every request: `SELECT 1` through the
   * pool, inside the readiness probe's timeout.
   *
   * `run.ts` sets `HEALTH_CACHE_TTL_MS=0` for the run, and without that this
   * row would measure nothing. The default is 1000ms, so at this arrival rate
   * roughly 149 of every 150 probes would be answered from the probe's own
   * cache and the number here would be a copy of the row above — a budget on a
   * database round trip that no database round trip was ever made for.
   */
  'GET /v1/health/ready': { p95Ms: 40, minRequests: 1500 },

  /**
   * The real read path, served warm: bearer decode and verify, the
   * request-scoped container, the object-level authorisation check, a hit in
   * `usersCache`, the entity tag, the response envelope, serialisation.
   *
   * One id for the whole run, requested every ~33ms against a 5s TTL, and
   * pre-warmed by `run.ts` before k6 starts — so every request in the run is a
   * hit, including the first.
   */
  'GET /v1/users/:id (cached)': { p95Ms: 30, minRequests: 1500 },

  /**
   * The same route with the cache defeated, which is the row that catches a
   * regression in the repository or in the SQL it sends.
   *
   * `usersCache` is a 200-entry LRU keyed on principal and URL. The profile
   * cycles through `LOAD_USER_POOL_SIZE` ids in `iterationInTest` order, and
   * that number is more than twice the store's capacity, so an id is always
   * evicted before it is asked for again: every request in this row is a miss
   * and reaches `findById`. Round-robin over a set larger than an LRU is the
   * classic worst case for it, and here that is the point rather than a flaw.
   *
   * The gap between this row and the one above it is what the cache buys.
   */
  'GET /v1/users/:id (uncached)': { p95Ms: 50, minRequests: 1500 },

  /**
   * Conditional revalidation: the same warm read, answered 304 from the
   * validator `run.ts` collected before the run.
   *
   * The task requires exactly 304 and not "2xx or 304". A 200 here means the
   * tag no longer describes the resource and this row has quietly become a
   * second copy of the cached row above — which would still be fast, and would
   * still pass a budget on latency alone.
   *
   * Its ceiling is the same as the unconditional read's, deliberately. A user
   * is about 230 bytes, so what revalidation saves is bytes rather than
   * milliseconds, and a ceiling encoding "the 304 must be faster" would be a
   * gate on noise. See `docs/load-testing.md`.
   */
  'GET /v1/users/:id (If-None-Match)': { p95Ms: 30, minRequests: 1500 },
};

/**
 * How many users the uncached row cycles through. `run.ts` seeds one more than
 * this and keeps the extra as the warm id, so the two rows never share a key.
 *
 * More than twice `usersCache`'s 200 entries, so round-robin guarantees a miss
 * on every request; small enough that seeding them is one statement. If
 * `MemoryCacheStore`'s capacity in `users.controller.ts` ever rises above half
 * of this, the uncached row stops being uncached — which is why the number is
 * here, next to the budget that depends on it, rather than in the profile.
 */
export const LOAD_USER_POOL_SIZE = 400;

/**
 * Where the run's artefacts go. Under `reports/`, which is already ignored by
 * git and already holds the mutation report, rather than a new top-level
 * directory.
 */
export const LOAD_REPORT_DIR = 'reports/load';
export const LOAD_SUMMARY_FILENAME = 'summary.json';
export const LOAD_SERVER_LOG_FILENAME = 'server.log';
