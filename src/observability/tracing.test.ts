import { SpanKind, TraceFlags, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import type { Sampler } from '@opentelemetry/sdk-trace-base';
import {
  UNTRACED_PATHS,
  createInstrumentations,
  createPropagator,
  createSampler,
  createSpanProcessor,
  otlpTracesUrl,
  resolveTracingConfig,
  shouldTracePath,
} from '@/observability/tracing';
import type { TracingConfig, TracingEnv } from '@/observability/tracing';

/**
 * The decisions, separated from the SDK that acts on them.
 *
 * Every function here is pure or nearly so, which is why they exist as functions
 * at all: the alternative shape — one `startTracing` that reads `env` and
 * assembles everything inline — is a bootstrap whose only test is "does the
 * process still start", and the things worth being sure of (that an upstream's
 * sampling decision is honoured, that a probe is not traced, that a pasted URL
 * is not posted to twice) are exactly the ones that shape hides.
 *
 * The SDK's own behaviour, the part that cannot be asserted in-process at all
 * because jest's module registry defeats `require`-based patching, is in
 * `tracing.integration.test.ts`.
 */

const BASE_ENV: TracingEnv = {
  NODE_ENV: 'test',
  OTEL_SDK_DISABLED: false,
  OTEL_SERVICE_NAME: 'boilerplate-express-ts',
  OTEL_SERVICE_VERSION: '',
  OTEL_TRACES_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_TRACES_SAMPLER_ARG: 1,
};

const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SPAN_ID = '1122334455667788';

/** Asks a sampler about a root span — no parent in the context. */
function sampleRoot(sampler: Sampler, traceId = TRACE_ID): SamplingDecision {
  return sampler.shouldSample(ROOT_CONTEXT, traceId, 'GET /v1/users', SpanKind.SERVER, {}, [])
    .decision;
}

/** Asks a sampler about a span whose parent arrived in a `traceparent`. */
function sampleWithParent(sampler: Sampler, parentSampled: boolean): SamplingDecision {
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: parentSampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });

  return sampler.shouldSample(parent, TRACE_ID, 'GET /v1/users', SpanKind.SERVER, {}, []).decision;
}

describe('resolveTracingConfig', () => {
  it('is disabled when the exporter is none', () => {
    // The default. Off is off: no patched modules, no span per query, nothing
    // built and discarded.
    expect(resolveTracingConfig(BASE_ENV).enabled).toBe(false);
  });

  it('is enabled for console with no endpoint needed', () => {
    const config = resolveTracingConfig({ ...BASE_ENV, OTEL_TRACES_EXPORTER: 'console' });

    expect(config.enabled).toBe(true);
    expect(config.otlpUrl).toBeUndefined();
  });

  it('is enabled for otlp and derives the traces URL', () => {
    const config = resolveTracingConfig({
      ...BASE_ENV,
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });

    expect(config.enabled).toBe(true);
    expect(config.otlpUrl).toBe('http://collector:4318/v1/traces');
  });

  it('lets OTEL_SDK_DISABLED win over a configured exporter', () => {
    // The property that makes it a kill switch rather than one more setting: an
    // operator turning tracing off in an incident must not have to also find and
    // change the exporter, and a switch another value can override is not one.
    const config = resolveTracingConfig({
      ...BASE_ENV,
      OTEL_SDK_DISABLED: true,
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });

    expect(config.enabled).toBe(false);
    expect(config.exporter).toBe('none');
    // And no exporter URL is derived, so nothing downstream can decide to use it.
    expect(config.otlpUrl).toBeUndefined();
  });

  it('omits an empty service version rather than reporting it', () => {
    // A `service.version` of `''` is worse than none: it looks like an answer,
    // and every release compares equal to every other.
    expect(resolveTracingConfig(BASE_ENV).serviceVersion).toBeUndefined();
    expect(
      resolveTracingConfig({ ...BASE_ENV, OTEL_SERVICE_VERSION: '1.4.2' }).serviceVersion,
    ).toBe('1.4.2');
  });

  it('reports NODE_ENV as the deployment environment', () => {
    expect(resolveTracingConfig({ ...BASE_ENV, NODE_ENV: 'production' }).environment).toBe(
      'production',
    );
  });

  it('passes the sample ratio through unchanged', () => {
    expect(
      resolveTracingConfig({ ...BASE_ENV, OTEL_TRACES_SAMPLER_ARG: 0.05 }).sampleRatio,
    ).toBe(0.05);
  });
});

describe('otlpTracesUrl', () => {
  it.each([
    ['http://collector:4318', 'http://collector:4318/v1/traces'],
    // A trailing slash is what a config system adds; left in it produces
    // `//v1/traces`, which some collectors 404 and others route to nothing.
    ['http://collector:4318/', 'http://collector:4318/v1/traces'],
    ['http://collector:4318///', 'http://collector:4318/v1/traces'],
    // The full path, because half the exporter docs show it that way. Appending
    // again gives `/v1/traces/v1/traces` and a collector that rejects every
    // export while the service looks entirely healthy.
    ['http://collector:4318/v1/traces', 'http://collector:4318/v1/traces'],
    ['http://collector:4318/v1/traces/', 'http://collector:4318/v1/traces'],
    // A gateway that serves the collector under a prefix. The prefix is kept:
    // only the protocol's own path is appended.
    ['https://otel.example.com/ingest', 'https://otel.example.com/ingest/v1/traces'],
  ])('turns %s into %s', (endpoint, expected) => {
    expect(otlpTracesUrl(endpoint)).toBe(expected);
  });
});

describe('shouldTracePath', () => {
  it('traces an ordinary request path', () => {
    expect(shouldTracePath('/v1/users')).toBe(true);
  });

  it('skips the readiness probe', () => {
    // The highest-volume endpoint most services have, and one span of no
    // interest per hit.
    expect(shouldTracePath('/v1/health')).toBe(false);
  });

  it('skips it with a query string attached', () => {
    // A prober can add one at any time, and a filter matching on the whole URL
    // silently stops working when it does.
    expect(shouldTracePath('/v1/health?probe=readiness')).toBe(false);
  });

  it('traces a path that merely starts with an untraced one', () => {
    // Exact match, not prefix: `/v1/healthcheck-admin` is somebody's endpoint and
    // dropping it would be a gap nobody could explain from the config.
    expect(shouldTracePath('/v1/healthcheck-admin')).toBe(true);
  });

  it('traces a request whose url the runtime did not give us', () => {
    // `IncomingMessage.url` is typed optional. Defaulting to "trace it" keeps a
    // malformed request visible; defaulting the other way loses exactly the
    // requests worth seeing.
    expect(shouldTracePath(undefined)).toBe(true);
  });

  it('has the health endpoint in the untraced list', () => {
    expect(UNTRACED_PATHS).toContain('/v1/health');
  });
});

describe('createSampler', () => {
  it('honours a sampled parent even at ratio 0', () => {
    // The assertion the whole sampler design exists for. Without parent-based
    // delegation, sampling multiplies at every hop: four services at 0.1 keep
    // one trace in ten thousand whole, and the rest arrive as fragments that
    // look like unexplained gaps.
    expect(sampleWithParent(createSampler(0), true)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('honours an unsampled parent even at ratio 1', () => {
    // The other half, and the one that is easy to get backwards. The upstream
    // decided not to keep this trace; recording our half of it produces a trace
    // that begins in the middle.
    expect(sampleWithParent(createSampler(1), false)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('samples every root span at ratio 1', () => {
    expect(sampleRoot(createSampler(1))).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('samples no root span at ratio 0', () => {
    expect(sampleRoot(createSampler(0))).toBe(SamplingDecision.NOT_RECORD);
  });

  it('decides a root span from the trace id, not from a counter', () => {
    // Determinism on the trace id is what makes a ratio usable across replicas:
    // every service asked about the same trace gives the same answer, so a
    // sampled trace is sampled everywhere rather than in a random subset of hops.
    const sampler = createSampler(0.5);
    const first = sampleRoot(sampler, '0'.repeat(31) + '1');

    expect(sampleRoot(sampler, '0'.repeat(31) + '1')).toBe(first);
  });
});

describe('createPropagator', () => {
  it('announces exactly the W3C fields', () => {
    // `fields()` is what a peer inspects to learn what this service writes.
    // Asserting the set is asserting the wire format: a propagator that had
    // gained `b3` or lost `baggage` would show up here rather than in a
    // correlation that quietly stopped working.
    expect(createPropagator().fields().sort()).toEqual(['baggage', 'traceparent', 'tracestate']);
  });
});

describe('createInstrumentations', () => {
  /**
   * Asserted on the config rather than end to end, because there is no end to
   * assert on: `fs` being *off* has no observable effect, which is exactly why a
   * regression here would ship. The `http` hook is the opposite — the integration
   * suite proves it against a real request — so this covers the three that
   * nothing else can.
   */
  const disabled = ['@opentelemetry/instrumentation-fs', '@opentelemetry/instrumentation-dns', '@opentelemetry/instrumentation-net'];

  it.each(disabled)('leaves %s disabled', (name) => {
    const found = createInstrumentations().find(
      (instrumentation) => instrumentation.instrumentationName === name,
    );

    // Present-but-disabled and absent-entirely are both acceptable: the package
    // decides which instrumentations it bundles, and the claim here is only that
    // this one is not going to produce spans.
    expect(found?.getConfig().enabled ?? false).toBe(false);
  });

  it('leaves the instrumentation this service depends on enabled', () => {
    // The counterweight. A test that only checks what is off passes just as well
    // when everything is off, which is a service that produces no traces at all.
    const enabled = createInstrumentations()
      .filter((instrumentation) => instrumentation.getConfig().enabled !== false)
      .map((instrumentation) => instrumentation.instrumentationName);

    expect(enabled).toContain('@opentelemetry/instrumentation-http');
    expect(enabled).toContain('@opentelemetry/instrumentation-express');
    expect(enabled).toContain('@opentelemetry/instrumentation-pg');
    expect(enabled).toContain('@opentelemetry/instrumentation-ioredis');
  });
});

describe('createSpanProcessor', () => {
  const config = (overrides: Partial<TracingConfig>): TracingConfig => ({
    ...resolveTracingConfig(BASE_ENV),
    ...overrides,
  });

  it('builds nothing for the none exporter', () => {
    expect(createSpanProcessor(config({ exporter: 'none' }))).toBeUndefined();
  });

  it('builds a processor for console', () => {
    expect(createSpanProcessor(config({ exporter: 'console' }))).toBeDefined();
  });

  it('builds a processor for otlp with a URL', () => {
    expect(
      createSpanProcessor(config({ exporter: 'otlp', otlpUrl: 'http://collector:4318/v1/traces' })),
    ).toBeDefined();
  });

  it('throws for otlp without a URL rather than exporting nowhere', () => {
    // Unreachable through `resolveTracingConfig` and refused at boot by the env
    // invariant, so this pins the last line of defence: the alternative to
    // throwing is an exporter posting to a hostless URL, which the SDK logs and
    // swallows — tracing that appears to be on and delivers nothing.
    expect(() => createSpanProcessor(config({ exporter: 'otlp', otlpUrl: undefined }))).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });
});
