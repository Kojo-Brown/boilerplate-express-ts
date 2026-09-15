import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Registry } from '@prometheus-io/client';

/**
 * The scrape endpoint — mounted at `env.METRICS_PATH`, outside `/v1`.
 *
 * Two things it deliberately is not:
 *
 * **Not JSON.** Everything else in this service answers with the `ApiResponse`
 * envelope from `@/lib/response`. This answers with the Prometheus exposition
 * format, because the consumer is a scraper that parses exactly that and
 * nothing else. It is the one route where the envelope would be wrong.
 *
 * **Not authenticated.** The exposition names every route this service has and
 * how often each is called, which is reconnaissance, so it should not be
 * reachable from the internet — but the control for that is the network, not a
 * credential: a scraper is configured with a target, not with a login, and the
 * standard deployments (a `ServiceMonitor` on a non-ingress port, a sidecar, a
 * private subnet) all rely on the endpoint not being published. Bearer auth on
 * a path a scraper cannot authenticate to would be a gate with a note next to
 * it saying how to turn it off. See `docs/metrics.md`.
 */
export function createMetricsRouter(registry: Registry): Router {
  const router: Router = Router();

  router.get('/', (_req: Request, res: Response, next: NextFunction) => {
    // `registry.metrics()` is async because a collector may be — the process
    // collectors read `/proc` on some platforms — and the rejection is handed
    // to `next` rather than swallowed. A scrape that fails should fail: a
    // scraper marks the target down and says so, where an empty 200 reads as a
    // service producing no traffic, which is the same shape as an outage.
    registry
      .metrics()
      .then((body) => {
        // The registry's own content type, which is `text/plain; version=0.0.4`
        // or the OpenMetrics one depending on whether exemplars are enabled —
        // so the header follows the exposition automatically instead of being a
        // second place to keep that decision.
        res.setHeader('Content-Type', registry.contentType);
        // A scrape is a point-in-time read of a counter. Cached — by a proxy
        // that saw `text/plain` and no directive — it produces a flat line and
        // a rate of zero, which is indistinguishable from a healthy idle
        // service and is how somebody spends an afternoon.
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(body);
      })
      .catch(next);
  });

  return router;
}
