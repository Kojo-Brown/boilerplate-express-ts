import {
  DURATION_BUCKETS,
  EXEMPLAR_TRACE_ID_LABEL,
  HTTP_REQUESTS_IN_FLIGHT,
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_SECONDS,
  createHttpMetrics,
  createMetricsRegistry,
} from '@/metrics/http-metrics';

describe('createMetricsRegistry', () => {
  it('serves the Prometheus text format by default', () => {
    expect(createMetricsRegistry({ exemplars: false }).contentType).toContain('text/plain');
  });

  it('serves OpenMetrics when exemplars are on, because that is where they exist', () => {
    expect(createMetricsRegistry({ exemplars: true }).contentType).toContain(
      'application/openmetrics-text',
    );
  });
});

describe('createHttpMetrics', () => {
  it('registers exactly the three RED instruments and nothing else', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    createHttpMetrics({ registry, exemplars: false });

    const names = registry.getMetricsAsArray().map((metric) => metric.name);
    expect(names.sort()).toEqual(
      [HTTP_REQUESTS_IN_FLIGHT, HTTP_REQUESTS_TOTAL, HTTP_REQUEST_DURATION_SECONDS].sort(),
    );
    await expect(registry.metrics()).resolves.toContain(HTTP_REQUESTS_TOTAL);
  });

  it('exposes the counter with the three labels the dashboard groups by', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    const metrics = createHttpMetrics({ registry, exemplars: false });

    metrics.requestsTotal.inc({ method: 'GET', route: '/v1/users', status_code: '200' });

    await expect(registry.metrics()).resolves.toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="/v1/users",status_code="200"} 1`,
    );
  });

  it('measures duration in seconds with the declared buckets', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    const metrics = createHttpMetrics({ registry, exemplars: false });

    metrics.requestDuration.observe({ method: 'GET', route: '/v1/users' }, 0.2);
    const exposition = await registry.metrics();

    for (const bucket of DURATION_BUCKETS) {
      expect(exposition).toContain(`${HTTP_REQUEST_DURATION_SECONDS}_bucket{le="${bucket}"`);
    }
    // Landed above 0.1 and at or below 0.25, which is what makes the boundaries
    // a statement about seconds rather than about whatever unit was handy.
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_bucket{le="0.1",method="GET",route="/v1/users"} 0`,
    );
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_bucket{le="0.25",method="GET",route="/v1/users"} 1`,
    );
  });

  /**
   * The cardinality decision, asserted rather than only argued in a comment:
   * the histogram must not grow a `status_code` dimension, because it is the
   * metric where a fourth label costs `buckets + 2` series instead of one.
   */
  it('keeps status_code off the duration histogram', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    const metrics = createHttpMetrics({ registry, exemplars: false });

    metrics.requestDuration.observe({ method: 'GET', route: '/v1/users' }, 0.2);
    const exposition = await registry.metrics();

    // The exposed series carries method and route and stops there. Asserted on
    // the `_count` line because it is the one with no `le` of its own, so the
    // full label set is visible in it.
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_count{method="GET",route="/v1/users"} 1`,
    );
    expect(exposition).not.toContain('status_code');
  });

  it('keeps the in-flight gauge to a bounded label set', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    const metrics = createHttpMetrics({ registry, exemplars: false });

    metrics.requestsInFlight.inc({ method: 'GET' });
    metrics.requestsInFlight.dec({ method: 'GET' });

    await expect(registry.metrics()).resolves.toContain(
      `${HTTP_REQUESTS_IN_FLIGHT}{method="GET"} 0`,
    );
  });

  it('reports whether exemplars were built in, so a caller cannot guess wrong', () => {
    const plain = createMetricsRegistry({ exemplars: false });
    const openMetrics = createMetricsRegistry({ exemplars: true });

    expect(createHttpMetrics({ registry: plain, exemplars: false }).exemplars).toBe(false);
    expect(createHttpMetrics({ registry: openMetrics, exemplars: true }).exemplars).toBe(true);
  });

  it('attaches a trace id to the bucket an observation landed in', async () => {
    const registry = createMetricsRegistry({ exemplars: true });
    const metrics = createHttpMetrics({ registry, exemplars: true });

    metrics.requestDuration.observe({
      labels: { method: 'GET', route: '/v1/users' },
      value: 0.2,
      exemplarLabels: { [EXEMPLAR_TRACE_ID_LABEL]: '4bf92f3577b34da6a3ce929d0e0e4736' },
    });

    const exposition = await registry.metrics();
    // On the `le="0.25"` bucket and only that one — an exemplar belongs to the
    // bucket the observation fell in, which is what lets a click on a latency
    // panel land on a request that was actually that slow.
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_bucket{le="0.25",method="GET",route="/v1/users"} 1 ` +
        `# {${EXEMPLAR_TRACE_ID_LABEL}="4bf92f3577b34da6a3ce929d0e0e4736"}`,
    );
    // The exemplar is not a label: the series is still keyed by method and
    // route alone, which is the whole reason a trace id can be attached at all.
    // If it had become a label there would be one series per request, and this
    // `_count` line would carry the id.
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_count{method="GET",route="/v1/users"} 1`,
    );
  });

  /**
   * The failure mode behind `HttpMetrics.exemplars` existing. The client refuses
   * at construction, so a deployment that turned exemplars on without the
   * OpenMetrics registry fails at boot rather than on the response path of a
   * live request.
   */
  it('refuses to build an exemplar histogram on a Prometheus registry', () => {
    const registry = createMetricsRegistry({ exemplars: false });

    expect(() => createHttpMetrics({ registry, exemplars: true })).toThrow(/OpenMetrics/i);
  });
});
