import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { EXEMPLAR_TRACE_ID_LABEL } from '@/metrics/http-metrics';
import type { HttpMetrics } from '@/metrics/http-metrics';
import { methodLabel } from '@/metrics/labels';
import type { RouteLabeller } from '@/metrics/labels';
import { activeTraceContext } from '@/observability/propagation';
import type { ActiveTrace } from '@/observability/propagation';

/**
 * One middleware, one observation per request, and the awkward parts are all
 * about when a request is actually over.
 *
 * It belongs *first* in the chain — ahead of the body parsers, the session
 * lookup and passport — because the histogram is meant to answer "how long did
 * the client wait", and a middleware installed after those measures the handler
 * and reports it as the request's latency. The gap between the two is precisely
 * where a slow session store hides.
 */

/**
 * The status recorded for a request whose client disconnected before a response
 * was finished.
 *
 * nginx's code, borrowed rather than invented: it is non-standard, it is never
 * sent on the wire, and it is already what an ops team reads as "the caller
 * hung up". The alternative — recording `res.statusCode`, which is still its
 * `200` default on an aborted request — reports the service as having
 * successfully served something it did not serve, and hides the failure this
 * label exists to show. Abandoned requests are usually a symptom of *this*
 * service being slow, so they are worth counting rather than dropping.
 */
export const CLIENT_CLOSED_REQUEST = '499';

export interface MetricsMiddlewareOptions {
  readonly metrics: HttpMetrics;
  readonly labeller: RouteLabeller;
  /**
   * Paths that are not measured at all, matched exactly against `req.path`.
   *
   * Two kinds of traffic belong here and both would otherwise drown the
   * dashboard rather than inform it — see `UNMEASURED_PATHS`, which is where
   * the specific ones are chosen and argued.
   */
  readonly ignoredPaths?: readonly string[];
}

export function createMetricsMiddleware(options: MetricsMiddlewareOptions): RequestHandler {
  const { metrics, labeller } = options;
  const ignored = new Set(options.ignoredPaths ?? []);

  return function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (ignored.has(req.path)) {
      next();
      return;
    }

    const method = methodLabel(req.method);
    // `hrtime` and not `Date.now()`: a histogram's smallest bucket here is 5ms
    // and the wall clock's resolution is not a promise, so a clock stepped by
    // NTP mid-request can produce a negative duration — which lands in the
    // first bucket and is invisible afterwards.
    const startedAt = process.hrtime.bigint();

    // Read *now*, at the top of the chain, while the request's context is still
    // the active one. By the time the listeners below fire the response is
    // finished, the context has been restored, and asking for the active span
    // there would return whatever else this process happens to be doing — the
    // same trap `Request.traceId` exists to keep the access log out of.
    const trace: ActiveTrace | undefined = metrics.exemplars ? activeTraceContext() : undefined;

    metrics.requestsInFlight.inc({ method });

    let recorded = false;
    const record = (): void => {
      // Both events fire for an ordinary request — `finish` when the response
      // is written, `close` when the socket is done with — and exactly one
      // fires for an abandoned one. Listening for `finish` alone leaks the
      // gauge on every client that hangs up, which is the metric drifting
      // upward forever and reading as a service that is slowly wedging.
      if (recorded) return;
      recorded = true;
      res.removeListener('finish', record);
      res.removeListener('close', record);

      metrics.requestsInFlight.dec({ method });

      // Only now: `req.route` is set by the router when it dispatches, so the
      // pattern does not exist until the request has been through it.
      const route = labeller.label(req);
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const statusCode = res.writableEnded ? String(res.statusCode) : CLIENT_CLOSED_REQUEST;

      metrics.requestsTotal.inc({ method, route, status_code: statusCode });

      // Two call shapes for one observation, and they are not
      // interchangeable: enabling exemplars on a histogram *replaces* its
      // `observe`, and the replacement only understands the object form. So the
      // branch is on how the metric was built, never on whether this particular
      // request has a trace — an unsampled request on an exemplar-enabled
      // histogram still has to go the object way, with no exemplar attached.
      if (metrics.exemplars) {
        metrics.requestDuration.observe({
          labels: { method, route },
          value: seconds,
          // Sampled, not merely traced. An exemplar is a link, and a link to a
          // trace that was never exported is a dead one — the dot appears on
          // the panel, the click lands on "trace not found", and the operator
          // learns to stop clicking. Under the default
          // `OTEL_TRACES_SAMPLER_ARG=1` this is every request; it starts
          // mattering the day the export bill does.
          exemplarLabels:
            trace?.sampled === true ? { [EXEMPLAR_TRACE_ID_LABEL]: trace.traceId } : undefined,
        });
        return;
      }

      metrics.requestDuration.observe({ method, route }, seconds);
    };

    res.on('finish', record);
    res.on('close', record);

    next();
  };
}
