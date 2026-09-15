import { createMetricsRegistry } from '@/metrics/http-metrics';
import { startProcessMetrics } from '@/metrics/process-metrics';

describe('startProcessMetrics', () => {
  it('registers the collectors an investigation that starts on RED ends on', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    startProcessMetrics(registry);

    const exposition = await registry.metrics();

    // Named individually rather than counted, because these four are the ones
    // that answer "every route got slower and none of them changed".
    expect(exposition).toContain('nodejs_eventloop_lag_p99_seconds');
    expect(exposition).toContain('nodejs_heap_size_used_bytes');
    expect(exposition).toContain('process_resident_memory_bytes');
    expect(exposition).toContain('nodejs_gc_duration_seconds');
  });

  it('collects on scrape rather than on a timer, so there is nothing to shut down', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    startProcessMetrics(registry);

    // Two scrapes off one registration. If the collectors were pushing on an
    // interval instead, this function would need a counterpart in
    // `shutdownPhases` and an e2e suite that touched it would leak a handle.
    await expect(registry.metrics()).resolves.toContain('process_cpu_seconds_total');
    await expect(registry.metrics()).resolves.toContain('process_cpu_seconds_total');
  });

  it('throws on a second registration rather than picking a silent winner', () => {
    const registry = createMetricsRegistry({ exemplars: false });
    startProcessMetrics(registry);

    expect(() => {
      startProcessMetrics(registry);
    }).toThrow();
  });
});
