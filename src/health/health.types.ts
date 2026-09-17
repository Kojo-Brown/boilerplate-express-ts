/**
 * The vocabulary the two probes share.
 *
 * Kept in its own module because the checks, the probe that runs them and the
 * router that renders them all need these names, and a type defined next to any
 * one of the three would make the other two import it from a place that has
 * nothing to do with them.
 */

/**
 * Whether a dependency being unreachable should take this instance out of the
 * load balancer, and it is the single most consequential field here.
 *
 * `critical` means the instance cannot serve requests without it: readiness
 * goes 503 and the balancer stops routing here. Postgres is the example — every
 * route that does anything reads or writes through the pool.
 *
 * `optional` means the instance can still serve, with something behind it
 * degraded. Redis is the example in this service: the API writes domain events
 * into `outbox_messages` inside the request's own transaction and the *relay*
 * delivers them, so a Redis outage delays delivery and fails nothing a client
 * can see. Marking it `critical` would take every replica out of the pool for a
 * dependency no request touches — converting a background-processing incident
 * into a total outage, which is the single most common way a readiness probe
 * makes an incident worse than the fault that started it.
 *
 * The rule the classification comes from: a dependency is `critical` only if a
 * *different, healthy* replica would serve the request better than this one.
 * Redis is down for all of them, so removing any of them helps nobody.
 */
export type DependencyCriticality = 'critical' | 'optional';

/** The outcome of one check. A check either answered or it did not. */
export type CheckStatus = 'ok' | 'failed';

/**
 * The instance's answer to "should I be sent traffic".
 *
 * - `ok` — every check passed.
 * - `degraded` — an `optional` check failed. Still 200, still in the pool, and
 *   the thing an alert fires on. A status that only distinguished ready from
 *   unready would have to call this one of the two, and both are wrong: `ok`
 *   hides a real fault, `unready` sheds traffic the instance can serve.
 * - `unready` — a `critical` check failed, or the process is draining.
 */
export type ReadinessStatus = 'ok' | 'degraded' | 'unready';

/**
 * One dependency, and how to ask it whether it is there.
 *
 * `run` resolves when the dependency answered and throws when it did not.
 * Returning a status instead was the other option and is worse: a driver that
 * cannot reach its server already throws, so a status-returning check has two
 * failure channels and every implementation has to remember to convert one into
 * the other. There is exactly one here, and it is the one the dependency
 * already uses.
 *
 * The `signal` is aborted when the check's deadline expires. Honouring it is
 * how a check releases whatever it was holding — see `runCheck`, which bounds
 * the *endpoint* whether or not a check cooperates, and `createPostgresCheck`,
 * which is what cooperating looks like.
 */
export interface DependencyCheck {
  /** Stable, and the label an operator greps for. */
  readonly name: string;
  readonly criticality: DependencyCriticality;
  run(signal: AbortSignal): Promise<void>;
}

export interface CheckResult {
  readonly name: string;
  readonly criticality: DependencyCriticality;
  readonly status: CheckStatus;
  /** Wall-clock cost of this check, rounded to a millisecond. */
  readonly durationMs: number;
  /**
   * Why it failed. Present on every failure inside the process, and stripped
   * from the *response* by `redactReport` unless `HEALTH_EXPOSE_ERRORS` is on.
   *
   * The two are separate on purpose: a readiness endpoint is routinely
   * reachable from further away than the API it guards, and a `pg` connection
   * error names the host, port and database it could not reach. Which check
   * failed is the part a client of the probe needs; why it failed belongs in
   * this process's logs, where the transition is already written once.
   */
  readonly error?: string;
}

export interface ReadinessReport {
  readonly status: ReadinessStatus;
  readonly checks: readonly CheckResult[];
  /** When the checks behind this report ran — not when it was served. */
  readonly checkedAt: number;
}

/**
 * Where a health subsystem writes, injected for the same reason
 * `GracefulShutdownOptions` injects one: every test in this directory would
 * otherwise print a dependency failure it created on purpose.
 */
export interface HealthLogger {
  log(message: string): void;
  warn(message: string): void;
}
