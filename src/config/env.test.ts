import { env } from '@/config/env';

describe('env', () => {
  it('is frozen in every environment, not only in dev', () => {
    // Fifteen modules import this and treat it as a constant, and it is walked
    // exactly once at boot — there is no hot path here to buy back by making
    // the freeze conditional.
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('rejects the write a test reaches for to force a branch', () => {
    expect(() => {
      // The cast is what such a test would have to write now: `env` is typed
      // `DeepReadonly`, so the assignment is a compile error first. Without the
      // freeze it would succeed, leak into every later test in that file, and
      // fail somewhere else entirely.
      (env as { NODE_ENV: string }).NODE_ENV = 'production';
    }).toThrow(TypeError);

    expect(env.NODE_ENV).toBe('test');
  });

  it('leaves tracing off unless a deployment asks for it', () => {
    // Asserted on `env` rather than on `resolveTracingConfig`, because what this
    // pins is the *default*: nothing in `jest.setup.ts` turns tracing off, so if
    // the schema's default ever became `console` or `otlp`, every suite in this
    // repository would start patching modules and opening an exporter. The two
    // in-process tracing suites register their own providers deliberately; none
    // of the other hundred and fifty should acquire one by accident.
    expect(env.OTEL_TRACES_EXPORTER).toBe('none');
    expect(env.OTEL_SDK_DISABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('');
  });

  it('leaves metrics on, which is the opposite default from tracing', () => {
    // Asserted because the asymmetry looks like an oversight and is not: a
    // tracer with no collector patches every instrumented module and fails
    // outward every few seconds, where a registry nobody scrapes is three
    // counters in memory. See docs/metrics.md.
    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.METRICS_PATH).toBe('/metrics');
    expect(env.METRICS_DEFAULT_METRICS).toBe(true);
  });

  it('caps route labels by default rather than trusting the router', () => {
    // The default that prevents an outage rather than enabling a graph. A
    // boilerplate shipping this unset would hand its first user an unbounded
    // `route` label the moment they mount a router on a parameterised path.
    expect(env.METRICS_MAX_ROUTE_LABELS).toBe(200);
  });

  it('leaves exemplars off, because turning them on changes the wire format', () => {
    // `true` here would switch every deployment's exposition to OpenMetrics as
    // a side effect of upgrading, and would refuse to boot wherever tracing is
    // off — which, per the default above, is everywhere.
    expect(env.METRICS_EXEMPLARS).toBe(false);
  });

  it('keeps every trace whole by default', () => {
    // A boilerplate that ships sampling at less than 1 hands its first user an
    // incomplete trace and no clue why. Lowering it is a decision made against a
    // real export bill.
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe(1);
  });

  it('gives a readiness check less time than any prober will give the probe', () => {
    // The number that has to stay under the probe's own `timeoutSeconds`, whose
    // usual value is 5. When it does not, the prober gives up first and every
    // dependency incident is reported as "probe timed out" with no indication
    // of which dependency — the one failure of this subsystem that produces no
    // information at all. Per check rather than for the set, because the checks
    // run concurrently.
    expect(env.HEALTH_CHECK_TIMEOUT_MS).toBe(2_000);
  });

  it('caches a readiness report for long enough to collapse pollers and no longer', () => {
    // A cached report is stale in both directions, so this is also how long a
    // failed dependency keeps being reported healthy. An order of magnitude
    // below the probe interval merges the kubelet, the balancer nodes, the mesh
    // and the uptime monitor into one set of checks; at the probe interval it
    // silently halves the rate at which anything is noticed.
    expect(env.HEALTH_CACHE_TTL_MS).toBe(1_000);
  });

  it('keeps dependency failure reasons out of the response by default', () => {
    // A readiness endpoint is routinely reachable from further away than the
    // API it guards, and a `pg` connection error names the host, port and
    // database it could not reach.
    expect(env.HEALTH_EXPOSE_ERRORS).toBe(false);
  });

  it('never tells a prober to retry immediately', () => {
    // 0 reads as flapping rather than as leaving, on both the drain answer and
    // the dependency one.
    expect(env.HEALTH_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });
});
