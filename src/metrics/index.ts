/**
 * The metrics barrel.
 *
 * `app-metrics` is re-exported here, unlike `observability/register`, and the
 * difference is what the import *does*: building a registry has no side effect
 * beyond allocating it, so where the line sits does not change behaviour. The
 * tracing SDK patches modules as they load, which is why that one is imported
 * by its own path and this one is not.
 */
export { UNMEASURED_PATHS, appMetrics } from '@/metrics/app-metrics';
export type { AppMetrics } from '@/metrics/app-metrics';

export {
  DURATION_BUCKETS,
  EXEMPLAR_TRACE_ID_LABEL,
  HTTP_REQUESTS_IN_FLIGHT,
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_SECONDS,
  createHttpMetrics,
  createMetricsRegistry,
} from '@/metrics/http-metrics';
export type { HttpMetrics, HttpMetricsOptions } from '@/metrics/http-metrics';

export {
  METHOD_OTHER,
  ROUTE_OVER_LIMIT,
  ROUTE_UNMATCHED,
  createRouteLabeller,
  methodLabel,
  normalizeRoutePath,
  routePattern,
} from '@/metrics/labels';
export type { RouteLabeller, RouteLabellerOptions } from '@/metrics/labels';

export { CLIENT_CLOSED_REQUEST, createMetricsMiddleware } from '@/metrics/metrics.middleware';
export type { MetricsMiddlewareOptions } from '@/metrics/metrics.middleware';

export { createMetricsRouter } from '@/metrics/metrics.router';

export { startProcessMetrics } from '@/metrics/process-metrics';
