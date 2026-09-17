import { runChecks } from '@/health/run-check';
import type {
  CheckResult,
  DependencyCheck,
  HealthLogger,
  ReadinessReport,
  ReadinessStatus,
} from '@/health/health.types';

export interface ReadinessProbeOptions {
  /**
   * The checks to run, read on every evaluation rather than captured once.
   *
   * A function and not an array because registration happens in `server.ts`,
   * after `createApp()` has already built the router that holds this probe.
   * Capturing the array at construction would produce a probe that reports an
   * empty check list forever, with nothing anywhere reporting an error — the
   * failure being a *green* readiness endpoint that checks nothing, which is
   * the one failure mode of a health subsystem that nobody notices.
   */
  readonly checks: () => readonly DependencyCheck[];
  /** Per-check budget. See `runCheck`. */
  readonly timeoutMs: number;
  /** How long a report may be reused. See the note on collapsing pollers below. */
  readonly cacheTtlMs: number;
  readonly logger?: HealthLogger;
  /** Injected so the cache can be tested without waiting out a real TTL. */
  readonly now?: () => number;
}

export interface ReadinessProbe {
  /**
   * The current report, from the cache when it is fresh and from the
   * dependencies when it is not.
   *
   * A failing dependency is a *result* and never a rejection, so the only way
   * this rejects is a bug in the registry or in a check's construction. The
   * router deliberately does not catch that — see `createHealthRouter`.
   */
  evaluate(): Promise<ReadinessReport>;
}

const CONSOLE_LOGGER: HealthLogger = {
  log: (message) => {
    console.log(message);
  },
  warn: (message) => {
    console.warn(message);
  },
};

/**
 * Runs the registered dependency checks and reduces them to one answer.
 *
 * ## Why this is not just "run the checks"
 *
 * A readiness endpoint is polled, forever, by more things than its author
 * expects: the kubelet, every load-balancer node, a service mesh sidecar, an
 * external uptime monitor, and a dashboard someone left open. Each of them on
 * its own interval. The naive handler performs one `SELECT 1` per poller per
 * interval for the life of the deployment, which is tolerable — and then stops
 * being tolerable at exactly the wrong moment, because during a Postgres
 * incident every one of those probes queues for a pool client, and the health
 * check starts consuming the capacity it exists to report on.
 *
 * Two mechanisms, and they cover different windows:
 *
 * - **Single-flight** collapses probes that *overlap*. It is the one that
 *   matters during an incident, when a check takes its full budget and a dozen
 *   pollers arrive inside it; without it each gets its own pool client.
 * - **The TTL** collapses probes that are merely *close together* — the
 *   staggered-by-milliseconds case, which is the normal one, because a healthy
 *   `SELECT 1` returns in under a millisecond and therefore never overlaps
 *   anything.
 *
 * The TTL is deliberately short (a second, by default) and is not a way to
 * probe less often. It is bounded above by what it costs: a cached report can
 * be up to `cacheTtlMs` stale in both directions — a dependency that has just
 * failed is still reported healthy, and one that has just recovered is still
 * reported failed. Keep it an order of magnitude below the probe interval and
 * it only ever merges simultaneous pollers; raise it towards the interval and
 * it becomes the interval.
 *
 * Draining is deliberately *not* handled here. It is not a dependency, it must
 * never be served from a cache, and it is the router's first question — see
 * `createHealthRouter`.
 */
export function createReadinessProbe(options: ReadinessProbeOptions): ReadinessProbe {
  const { checks, timeoutMs, cacheTtlMs, logger = CONSOLE_LOGGER, now = Date.now } = options;

  let cached: ReadinessReport | null = null;
  let inFlight: Promise<ReadinessReport> | null = null;
  let lastSignature: string | null = null;

  async function evaluateNow(startedAt: number): Promise<ReadinessReport> {
    const results = await runChecks(checks(), { timeoutMs });
    const report: ReadinessReport = {
      status: classify(results),
      checks: results,
      // The instant the checks *began*, not the instant they finished. Dating
      // the report at the end would let a check that took its whole budget stay
      // cached for the TTL on top of that budget, so the worst-case staleness
      // would be the sum rather than the TTL an operator configured.
      checkedAt: startedAt,
    };

    logTransition(report);
    cached = report;
    return report;
  }

  /**
   * One line per change of state, and nothing at all while it holds.
   *
   * Logging every evaluation would write a line per poller per interval — at
   * the probe rates above, tens of thousands a day saying the same thing, which
   * is both the cost of the log and the reason nobody reads it. Logging only
   * transitions means the line that does appear is an event.
   *
   * The signature covers each check's own status and not just the overall one,
   * so a second dependency failing while the first is still down is a
   * transition: the overall status stays `unready` either way, and "Postgres is
   * down" becoming "Postgres and Redis are down" is the more interesting half
   * of the incident.
   */
  function logTransition(report: ReadinessReport): void {
    const signature = `${report.status}|${report.checks
      .map((check) => `${check.name}=${check.status}`)
      .join(',')}`;

    if (signature === lastSignature) return;
    const first = lastSignature === null;
    lastSignature = signature;

    // The first evaluation is a transition from nothing, and announcing "now
    // ok" at boot is noise. A first evaluation that is *not* ok is not.
    if (first && report.status === 'ok') return;

    const failed = report.checks.filter((check) => check.status === 'failed');
    if (report.status === 'ok') {
      logger.log('[health] readiness recovered: all dependency checks passing');
      return;
    }

    logger.warn(
      `[health] readiness ${report.status}: ${failed
        .map((check) => `${check.name} (${check.criticality}) ${check.error ?? 'failed'}`)
        .join('; ')}`,
    );
  }

  return {
    async evaluate(): Promise<ReadinessReport> {
      const startedAt = now();

      if (cached !== null) {
        const age = startedAt - cached.checkedAt;
        // `age >= 0` and not just the upper bound: this is a wall clock, and a
        // backwards step from NTP makes a report look arbitrarily far in the
        // future — which, compared only against the TTL, would pin readiness to
        // one stale answer until the clock caught up. A negative age means the
        // cache cannot be reasoned about, so it is not used.
        if (age >= 0 && age < cacheTtlMs) return cached;
      }

      // Joining an in-flight evaluation rather than starting a second one. Safe
      // to hand the same promise to every caller because a report is immutable
      // and nobody may mutate what they were given.
      if (inFlight !== null) return inFlight;

      const run = evaluateNow(startedAt);
      inFlight = run;
      try {
        return await run;
      } finally {
        inFlight = null;
      }
    },
  };
}

/**
 * The single answer, and the precedence is the point: one failed `critical`
 * check outranks any number of healthy ones, because readiness is a claim that
 * this instance can serve a request end to end, and a request needs every
 * critical dependency rather than most of them.
 */
function classify(results: readonly CheckResult[]): ReadinessStatus {
  let degraded = false;

  for (const result of results) {
    if (result.status === 'ok') continue;
    if (result.criticality === 'critical') return 'unready';
    degraded = true;
  }

  return degraded ? 'degraded' : 'ok';
}

/**
 * The report as a client may see it.
 *
 * Applied at the edge and nowhere else — see `CheckResult.error` for why the
 * text is kept internally in the first place.
 */
export function redactReport(report: ReadinessReport, exposeErrors: boolean): ReadinessReport {
  if (exposeErrors) return report;

  return {
    ...report,
    checks: report.checks.map(({ error: _error, ...rest }) => rest),
  };
}
