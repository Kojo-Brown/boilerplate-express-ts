import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, propagation, trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  BAGGAGE_HEADER,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  activeTraceContext,
  extractTraceContext,
  injectTraceContext,
  withTraceContext,
} from '@/observability/propagation';
import { createPropagator, createSampler } from '@/observability/tracing';

/**
 * The W3C layer, against the real propagators and a real tracer.
 *
 * Nothing here is mocked, because every interesting assertion is about the
 * format: whether the string written into a carrier is one another service's
 * library can read, and whether the parent relationship survives a round trip
 * through it. A test double would only be asserting this file's own opinion of
 * what `traceparent` looks like, which is the thing most likely to be wrong.
 */

/** `00-<32 hex>-<16 hex>-<2 hex>`, the only shape a peer is required to accept. */
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

const UPSTREAM_TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const UPSTREAM_SPAN_ID = '1122334455667788';

function traceparent(traceId: string, spanId: string, flags: string): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;
let tracer: Tracer;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager.enable());
  propagation.setGlobalPropagator(createPropagator());

  provider = new BasicTracerProvider({
    sampler: createSampler(1),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  tracer = trace.getTracer('propagation.test');
});

afterEach(async () => {
  // The OpenTelemetry APIs are process-global and jest reuses a worker process
  // across test files. Left registered, this file's provider would still be the
  // global one while the next file ran, and a suite that passes alone and fails
  // in a full run is the result.
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
  propagation.disable();
});

describe('injectTraceContext', () => {
  it('writes a spec-shaped traceparent for the active span', () => {
    const span = tracer.startSpan('outbound');

    const carrier = context.with(trace.setSpan(context.active(), span), () =>
      injectTraceContext(),
    );
    span.end();

    const header = carrier[TRACEPARENT_HEADER];
    expect(header).toMatch(TRACEPARENT_PATTERN);
    // The ids in the header are the span's own, which is what makes the
    // consumer's span a child of *this* one rather than of the trace in general.
    expect(header).toContain(span.spanContext().traceId);
    expect(header).toContain(span.spanContext().spanId);
  });

  it('returns an empty carrier when there is no active span', () => {
    // The case a producer hits during boot, or with tracing disabled. An empty
    // carrier is the correct output: the alternative a naive implementation
    // produces is a well-formed traceparent with a zeroed trace id, which
    // backends reject without explaining why.
    expect(injectTraceContext()).toEqual({});
  });

  it('carries tracestate through untouched', () => {
    // tracestate is other vendors' data. A hop that drops it breaks their
    // sampling decisions while this service's own trace looks perfect. The value
    // is the W3C specification's own example, keys included.
    const inbound = {
      [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '01'),
      [TRACESTATE_HEADER]: 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
    };

    const carrier = context.with(extractTraceContext(inbound), () => injectTraceContext());

    expect(carrier[TRACESTATE_HEADER]).toBe('congo=t61rcWkgMzE,rojo=00f067aa0ba902b7');
  });

  it('drops a tracestate entry whose key is not spec-valid', () => {
    // Pinned because it is a trap with no error attached to it: tracestate keys
    // must be lowercase, so `vendorA=…` is silently discarded by the propagator
    // and a test written with a capital letter in it "proves" that tracestate is
    // dropped when what is wrong is the fixture. Values may be mixed case, which
    // is what makes the rule easy to half-remember.
    const inbound = {
      [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '01'),
      [TRACESTATE_HEADER]: 'vendorA=kept',
    };

    const carrier = context.with(extractTraceContext(inbound), () => injectTraceContext());

    expect(carrier[TRACESTATE_HEADER]).toBe('');
    // The traceparent is unaffected: a bad tracestate entry must not cost the
    // parent relationship, which is the part that makes the trace whole.
    expect(carrier[TRACEPARENT_HEADER]).toContain(UPSTREAM_TRACE_ID);
  });

  it('includes baggage set on the context', () => {
    const baggage = propagation.createBaggage({ tenant: { value: 'acme' } });

    const carrier = context.with(propagation.setBaggage(context.active(), baggage), () =>
      injectTraceContext(),
    );

    expect(carrier[BAGGAGE_HEADER]).toBe('tenant=acme');
  });
});

describe('extractTraceContext', () => {
  it('makes the carrier the remote parent of a span started under it', () => {
    const inbound = { [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '01') };

    context.with(extractTraceContext(inbound), () => {
      tracer.startSpan('consume').end();
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe(UPSTREAM_TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe(UPSTREAM_SPAN_ID);
  });

  it('reads the header whatever case the producer wrote it in', () => {
    // Not hypothetical: several HTTP clients title-case header names when they
    // copy them into a message body, and the failure is a silently new trace
    // rather than an error.
    const inbound = { Traceparent: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '01') };

    const spanContext = trace.getSpanContext(extractTraceContext(inbound));

    expect(spanContext?.traceId).toBe(UPSTREAM_TRACE_ID);
  });

  it('preserves the sampled flag the upstream set', () => {
    const sampled = extractTraceContext({
      [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '01'),
    });
    const unsampled = extractTraceContext({
      [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '00'),
    });

    expect(trace.getSpanContext(sampled)?.traceFlags).toBe(TraceFlags.SAMPLED);
    expect(trace.getSpanContext(unsampled)?.traceFlags).toBe(TraceFlags.NONE);
  });

  it.each([
    ['no traceparent at all', {}],
    ['a malformed traceparent', { [TRACEPARENT_HEADER]: 'not-a-traceparent' }],
    ['an all-zero trace id', { [TRACEPARENT_HEADER]: traceparent('0'.repeat(32), UPSTREAM_SPAN_ID, '01') }],
    ['an all-zero span id', { [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, '0'.repeat(16), '01') }],
    ['a truncated trace id', { [TRACEPARENT_HEADER]: '00-a1b2c3-1122334455667788-01' }],
  ])('yields no remote parent for %s', (_case, carrier: Record<string, string>) => {
    // Every one of these has to produce a *new* trace rather than an invalid
    // one. A span parented to a zeroed id is rejected by the backend on ingest,
    // so the request disappears from tracing entirely — worse than being the
    // root of its own trace, which is at least visible.
    expect(trace.getSpanContext(extractTraceContext(carrier))).toBeUndefined();
  });

  it('ignores whatever span is active when the carrier has none', () => {
    // The reason this function roots at ROOT_CONTEXT. A worker always has a
    // poll or a tick of its own in flight; inheriting it would parent every
    // unparented message under the loop that happened to pick it up.
    const pollSpan = tracer.startSpan('poll');

    const extracted = context.with(trace.setSpan(context.active(), pollSpan), () =>
      extractTraceContext({}),
    );
    pollSpan.end();

    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });

  it('accepts a future version byte, as the spec requires', () => {
    // Forward compatibility is a requirement, not a nicety: the first four
    // fields are fixed for every version, so a `01` peer's header must still
    // join this service's span to its trace rather than starting a new one.
    const inbound = { [TRACEPARENT_HEADER]: `99-${UPSTREAM_TRACE_ID}-${UPSTREAM_SPAN_ID}-01` };

    expect(trace.getSpanContext(extractTraceContext(inbound))?.traceId).toBe(UPSTREAM_TRACE_ID);
  });

  it('rejects the reserved ff version', () => {
    // `ff` is reserved by the spec and is the one version that must never be
    // accepted, so it is the one case where forward compatibility does not apply.
    const inbound = { [TRACEPARENT_HEADER]: `ff-${UPSTREAM_TRACE_ID}-${UPSTREAM_SPAN_ID}-01` };

    expect(trace.getSpanContext(extractTraceContext(inbound))).toBeUndefined();
  });
});

describe('withTraceContext', () => {
  it('runs the body with the carrier as the active trace', () => {
    const inbound = { [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '01') };

    const seen = withTraceContext(inbound, () => activeTraceContext());

    expect(seen).toEqual({
      traceId: UPSTREAM_TRACE_ID,
      spanId: UPSTREAM_SPAN_ID,
      sampled: true,
    });
  });

  it('restores the previous context afterwards', () => {
    withTraceContext(
      { [TRACEPARENT_HEADER]: traceparent(UPSTREAM_TRACE_ID, UPSTREAM_SPAN_ID, '01') },
      () => undefined,
    );

    expect(activeTraceContext()).toBeUndefined();
  });

  it('returns what the body returns', () => {
    expect(withTraceContext({}, () => 'handled')).toBe('handled');
  });
});

describe('a full producer-to-consumer round trip', () => {
  it('puts the work of the consumer in the trace of the producer', () => {
    // The whole point of the module in one test: a producer's span, serialised
    // into a carrier a `jsonb` column could hold, read back with no shared
    // memory, and the consumer's span landing in the same trace as a child.
    const producer = tracer.startSpan('outbox.enqueue');
    const carrier = context.with(trace.setSpan(context.active(), producer), () =>
      injectTraceContext(),
    );
    producer.end();

    const stored: Record<string, string> = JSON.parse(JSON.stringify(carrier));

    withTraceContext(stored, () => {
      tracer.startSpan('outbox.deliver').end();
    });

    const [producerSpan, consumerSpan] = exporter.getFinishedSpans();
    expect(consumerSpan?.spanContext().traceId).toBe(producerSpan?.spanContext().traceId);
    expect(consumerSpan?.parentSpanContext?.spanId).toBe(producerSpan?.spanContext().spanId);
  });
});

describe('activeTraceContext', () => {
  it('is undefined with no span in the context', () => {
    expect(activeTraceContext(ROOT_CONTEXT)).toBeUndefined();
  });

  it('reports sampled from the flag bit rather than the whole byte', () => {
    // `traceFlags` is a bit field. An implementation comparing it to `1` reads a
    // sampled span as unsampled the moment any other flag is set alongside it,
    // and the symptom is a trace that vanishes from the backend.
    const withExtraFlag = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: UPSTREAM_TRACE_ID,
      spanId: UPSTREAM_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED | 0b10,
    });

    expect(activeTraceContext(withExtraFlag)?.sampled).toBe(true);
  });
});
