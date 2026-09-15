import type { RequestHandler } from 'express';
import type { Registry } from '@prometheus-io/client';
import { env } from '@/config/env';
import { createHttpMetrics, createMetricsRegistry } from '@/metrics/http-metrics';
import type { HttpMetrics } from '@/metrics/http-metrics';
import { createRouteLabeller } from '@/metrics/labels';
import type { RouteLabeller } from '@/metrics/labels';
import { createMetricsMiddleware } from '@/metrics/metrics.middleware';

/**
 * This process's registry, assembled once from `env`.
 *
 * The composition root for metrics, in the sense `app.ts` is one for error
 * translators: every other module in `src/metrics/` takes what it needs as an
 * argument and can be built fresh by a test, and this is the single file that
 * reads configuration and holds the instance the running service uses.
 *
 * Built unconditionally, even with `METRICS_ENABLED=false`. Three counters and
 * a `Set` cost nothing unregistered, and the alternative — a nullable export —
 * would put a null check in `app.ts` and in every future caller to save them.
 * What the flag actually controls is whether `app.ts` mounts anything, which is
 * where the cost is: the middleware on every request and the endpoint on the
 * network.
 */

/**
 * Paths excluded from the RED metrics, and neither is an oversight.
 *
 * **The exposition itself.** Otherwise the busiest "endpoint" on the dashboard
 * is the scraper, at a fixed rate that dilutes every ratio computed across all
 * routes.
 *
 * **`/v1/health`.** A readiness probe outnumbers real traffic in anything but a
 * busy API, so its rate swamps the rate panel and its count dominates the error
 * *denominator* — but the reason it is excluded rather than merely noisy is
 * what it answers during a shutdown. `/v1/health` returns 503 for the whole
 * drain window by design, so with it measured, every rolling deploy paints a
 * 5xx spike on the error panel of a service that never failed a request. An
 * error rate that cries wolf on every deploy is an error rate nobody reads.
 *
 * The same two paths are excluded from tracing, for related but not identical
 * reasons — `UNTRACED_PATHS` in `@/observability/tracing`. Kept as two lists
 * because they answer two questions: a deployment that wanted probe latency
 * graphed should not have to start exporting a span per probe to get it.
 */
export const UNMEASURED_PATHS: readonly string[] = [env.METRICS_PATH, '/v1/health'];

export interface AppMetrics {
  readonly registry: Registry;
  readonly http: HttpMetrics;
  readonly labeller: RouteLabeller;
  readonly middleware: RequestHandler;
}

function createAppMetrics(): AppMetrics {
  const registry = createMetricsRegistry({ exemplars: env.METRICS_EXEMPLARS });
  const http = createHttpMetrics({ registry, exemplars: env.METRICS_EXEMPLARS });
  const labeller = createRouteLabeller({ maxLabels: env.METRICS_MAX_ROUTE_LABELS });

  return {
    registry,
    http,
    labeller,
    middleware: createMetricsMiddleware({
      metrics: http,
      labeller,
      ignoredPaths: UNMEASURED_PATHS,
    }),
  };
}

export const appMetrics: AppMetrics = createAppMetrics();
