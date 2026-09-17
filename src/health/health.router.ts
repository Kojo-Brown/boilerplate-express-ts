import { Router } from 'express';
import type { RequestHandler } from 'express';
import { sendFail, sendOk } from '@/lib/response';
import { redactReport } from '@/health/readiness';
import type { ReadinessProbe } from '@/health/readiness';
import type { Lifecycle } from '@/shutdown/lifecycle';

export interface HealthRouterOptions {
  readonly lifecycle: Lifecycle;
  readonly probe: ReadinessProbe;
  /** See `CheckResult.error`. */
  readonly exposeErrors: boolean;
  readonly retryAfterSeconds: number;
  /** Reported as `version` so the existing probe contract is unchanged. */
  readonly version?: string;
  /** Injected so the liveness body can be asserted without a moving number. */
  readonly uptimeSeconds?: () => number;
}

/**
 * The two probes, and they answer two different questions on purpose.
 *
 * ## Why splitting them is not a formality
 *
 * One endpoint cannot serve both, because the correct answer to each is
 * *opposite* in the two situations that matter.
 *
 * **During a drain.** Readiness must go 503 immediately, so the balancer stops
 * routing here while this instance is still able to answer. Liveness must stay
 * 200, because a kubelet that fails liveness restarts the container — and a
 * container restarted in the middle of its own graceful shutdown kills every
 * request the drain existed to finish. A single endpoint wired to both probes
 * has to pick one of those, and either choice breaks the other.
 *
 * **During a dependency outage.** Readiness must go 503 for a critical
 * dependency: this replica cannot serve, and the balancer should try another.
 * Liveness must stay 200, because the dependency is down for *every* replica,
 * and a liveness probe that checks dependencies restarts all of them at once —
 * repeatedly, since restarting changes nothing about Postgres. That converts a
 * database incident into a crash loop across the whole deployment, and the
 * reconnect storm from the restarts is actively in the way of recovery. It is
 * the most damaging thing a health endpoint can be made to do, and it is what
 * happens by default whenever liveness is pointed at a readiness handler.
 *
 * So the rule this module exists to hold: **liveness never touches a
 * dependency, and never lets the lifecycle decide its status code.** What it
 * reports is that this process is running and its event loop is turning far
 * enough to answer. That looks thin, and the thinness is the specification —
 * everything else that could be added to it is a new reason to kill a process
 * that would have recovered. It does *report* the lifecycle state in the body,
 * which is a different thing: an operator reading it is not going to restart
 * the container over it.
 *
 * ## The alias
 *
 * `GET /v1/health` is readiness, which is what it has always been: it returned
 * 503 for the drain window before this router existed, and a load balancer
 * pointed at it is reading readiness whether or not anyone called it that.
 * Keeping the path is what stops this split from being a breaking change for a
 * deployment that has not moved its probe configuration yet.
 */
export function createHealthRouter(options: HealthRouterOptions): Router {
  const {
    lifecycle,
    probe,
    exposeErrors,
    retryAfterSeconds,
    version = 'v1',
    uptimeSeconds = () => Math.floor(process.uptime()),
  } = options;

  const router: Router = Router();

  /**
   * Nothing between a probe and a stale answer.
   *
   * A readiness response is the one thing on this service that must never be
   * served from anybody's cache: a mesh sidecar or a CDN holding it for even a
   * few seconds is a balancer routing to an instance that left, or refusing one
   * that came back. `no-store` rather than `no-cache`, which permits storing it
   * and only requires revalidation.
   */
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * Liveness. Unconditional, and see the note above for why that is the answer
   * rather than an unfinished implementation.
   *
   * `state` is reported because it is the question an operator has when they
   * curl this during a deploy — "it says ok, is it going away?" — and answering
   * it in the body costs nothing. It is deliberately *not* wired to the status
   * code: reporting `draining` and returning 200 is the entire point.
   */
  router.get('/live', (_req, res) => {
    sendOk(res, {
      status: 'ok',
      version,
      state: lifecycle.state,
      uptimeSeconds: uptimeSeconds(),
    });
  });

  const readiness: RequestHandler = async (_req, res) => {
    // First, and ahead of the probe rather than inside it. Draining is not a
    // dependency: it is known locally, it is certain, and it must never be
    // served from the report cache — a cached `ok` from 800ms ago would keep
    // this instance in the pool after the signal landed, which is the one
    // moment the answer has to change instantly.
    if (!lifecycle.isReady) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      sendFail(
        res,
        503,
        'SERVER_DRAINING',
        'This instance is shutting down and is no longer ready for traffic',
      );
      return;
    }

    // Not wrapped in a try/catch. `probe.evaluate` does not reject for a failing
    // dependency — that is a result — so anything thrown here is a bug in the
    // probe itself, and Express 5 forwards it to `errorMiddleware` as a 500.
    // Answering 503 instead would dress a broken probe up as a dependency
    // outage, which is the one reading that sends an operator to the wrong
    // system.
    const report = redactReport(await probe.evaluate(), exposeErrors);

    if (report.status === 'unready') {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      sendFail(
        res,
        503,
        'NOT_READY',
        'A critical dependency is unavailable',
        // The per-check detail on the failure path too, because a bare 503 tells
        // an operator only that something is wrong with a service they can see
        // is wrong. Which check failed is the whole answer.
        [...report.checks],
      );
      return;
    }

    // 200 for `degraded` as well as `ok`, which is the deliberate half: an
    // optional dependency being down is something to alert on and not something
    // to shed traffic for. The distinction is in the body, where an alert can
    // read it, rather than in the status code, where a balancer would act on it.
    sendOk(res, {
      status: report.status,
      version,
      checks: report.checks,
      checkedAt: new Date(report.checkedAt).toISOString(),
    });
  };

  router.get('/ready', readiness);
  // The pre-split path. See "The alias" above.
  router.get('/', readiness);

  return router;
}
