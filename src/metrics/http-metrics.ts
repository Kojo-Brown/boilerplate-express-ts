import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  openMetricsContentType,
  prometheusContentType,
} from '@prometheus-io/client';

/**
 * The three instruments the RED method asks for, and nothing else.
 *
 * **R**ate, **E**rrors, **D**uration — the questions you ask of a request-driven
 * service, as opposed to USE (utilisation, saturation, errors), which is what
 * you ask of the machine underneath it. The split matters when choosing what to
 * put here: `process_resident_memory_bytes` is a fine metric and it is not one
 * of these, which is why it comes from the process collectors in
 * `process-metrics.ts` instead of being hand-rolled alongside the request path.
 *
 * Rate and errors are both `http_requests_total`: a rate is its derivative and
 * an error rate is the ratio of the `5xx` slice to the whole, so a second
 * counter for failures would be a second source of truth for one number. That
 * is the standard shape and it is why every RED dashboard expression starts
 * with `rate(http_requests_total[…])`.
 *
 * Names follow the Prometheus conventions rather than anything of this
 * service's own devising: `_total` on a counter, base units (seconds, not
 * milliseconds) on a histogram, and no `_count`/`_sum`/`_bucket` suffix on
 * anything, since those are the exposition's own and colliding with them
 * produces a series the scraper silently reinterprets.
 */

export const HTTP_REQUESTS_TOTAL = 'http_requests_total';
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';
export const HTTP_REQUESTS_IN_FLIGHT = 'http_requests_in_flight';

/**
 * The exemplar label, which is `trace_id` and cannot usefully be anything else:
 * it is the name Grafana and Tempo look for when turning an exemplar dot into a
 * link to a trace.
 */
export const EXEMPLAR_TRACE_ID_LABEL = 'trace_id';

/**
 * Seconds, and chosen against SLO thresholds rather than against a latency
 * distribution somebody measured once.
 *
 * A bucket is only ever *at* its boundary: `histogram_quantile` interpolates
 * inside one, so a p99 that lands between 1s and 2.5s is a straight-line guess
 * across that gap, and the useful reading is not the quantile at all — it is
 * `…_bucket{le="1"} / …_count`, the fraction of requests served inside one
 * second. That is an SLO, it is exact, and it is the reason the boundaries are
 * round numbers a human would write into one.
 *
 * Eleven of them, because each boundary is a series per route per method and
 * the cost of an extra one is paid on every scrape forever. They span 5ms —
 * below anything this service can serve, so the first bucket stays empty and
 * says so — to 10s, above which a request has already lost whoever sent it.
 */
export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

type RequestLabel = 'method' | 'route' | 'status_code';
type DurationLabel = 'method' | 'route';
type InFlightLabel = 'method';

/**
 * `trace_id` is in the *type* and not in `labelNames`, which looks wrong and is
 * not.
 *
 * The client types an observation's exemplar labels with the same parameter as
 * its metric labels (`ObserveDataWithExemplar<T>`), so the only way to attach
 * `trace_id` to an observation is for the histogram's label type to admit it.
 * It stays out of `labelNames`, which is what actually decides the series: an
 * exemplar is attached to a bucket, not to a label set, and a trace id that
 * became a label would be one time series per request — the single worst thing
 * this whole file is arranged to prevent.
 */
type DurationOrExemplarLabel = DurationLabel | typeof EXEMPLAR_TRACE_ID_LABEL;

export interface HttpMetrics {
  readonly requestsTotal: Counter<RequestLabel>;
  readonly requestDuration: Histogram<DurationOrExemplarLabel>;
  readonly requestsInFlight: Gauge<InFlightLabel>;
  /**
   * Whether `requestDuration` will accept an exemplar. Carried on the metrics
   * rather than read from `env` at the point of use, so the middleware records
   * what was actually built — the client throws when a metric that was created
   * without exemplars is handed some, and that throw would land on the response
   * path of a live request.
   */
  readonly exemplars: boolean;
}

export interface HttpMetricsOptions {
  readonly registry: Registry;
  /** Requires `registry` to be an OpenMetrics one; see `createMetricsRegistry`. */
  readonly exemplars: boolean;
}

/**
 * The registry the instruments are registered on.
 *
 * Its content type is not a formatting preference — it is what decides whether
 * exemplars are expressible at all. They are an OpenMetrics feature, the client
 * enforces that by refusing to *construct* an exemplar-enabled metric on a
 * Prometheus registry, and so the one flag picks both.
 *
 * A registry per call rather than the library's module-level default, which is
 * the same argument as every other singleton avoided in this repository: the
 * global one is shared by every test in the process, registering a metric name
 * on it twice throws, and the first suite to import a module that registers
 * something decides whether the tenth one passes.
 */
export function createMetricsRegistry(options: { readonly exemplars: boolean }): Registry {
  return new Registry(options.exemplars ? openMetricsContentType : prometheusContentType);
}

export function createHttpMetrics(options: HttpMetricsOptions): HttpMetrics {
  const registers = [options.registry];

  return {
    requestsTotal: new Counter<RequestLabel>({
      name: HTTP_REQUESTS_TOTAL,
      help: 'Total HTTP requests handled, by method, matched route pattern and status code.',
      labelNames: ['method', 'route', 'status_code'],
      registers,
    }),

    requestDuration: new Histogram<DurationOrExemplarLabel>({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'End-to-end HTTP request duration in seconds, by method and matched route pattern.',
      // No `status_code`, and this is the one label decision worth defending. A
      // histogram is `buckets + 2` series per label combination, so adding a
      // fourth dimension to it multiplies by far the heaviest metric here —
      // where the same dimension costs the counter one series each. The
      // questions it would answer ("how fast are the 500s?") are answerable
      // from traces, and the question it would cost you is the one you ask
      // first: how fast is this route. Put it back if you need it, and lower
      // `DURATION_BUCKETS` in the same commit.
      labelNames: ['method', 'route'],
      buckets: [...DURATION_BUCKETS],
      enableExemplars: options.exemplars,
      registers,
    }),

    requestsInFlight: new Gauge<InFlightLabel>({
      name: HTTP_REQUESTS_IN_FLIGHT,
      // Concurrency is not derivable from the other two: rate × duration is
      // Little's law, which holds in the mean and says nothing about the moment
      // the pool ran out. This is the metric that separates "slow" from "stuck"
      // — during a stall the rate falls, the duration histogram records nothing
      // at all because nothing has finished, and this is the only line that
      // moves.
      help: 'HTTP requests currently being served, by method.',
      // By method alone. Route would be the interesting cut and it is also
      // unbounded in the wrong direction here: a gauge keeps a series for every
      // combination it has ever seen, including the ones sitting at zero.
      labelNames: ['method'],
      registers,
    }),

    exemplars: options.exemplars,
  };
}
