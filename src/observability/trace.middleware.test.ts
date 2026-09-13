import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, propagation, trace } from '@opentelemetry/api';
import type { Baggage, Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Request, Response, NextFunction } from 'express';
import {
  CORRELATION_ID_ATTRIBUTE,
  CORRELATION_ID_BAGGAGE_KEY,
  TRACE_RESPONSE_HEADER,
  formatTraceResponse,
  traceContextMiddleware,
} from '@/observability/trace.middleware';
import { TRACEPARENT_HEADER, injectTraceContext } from '@/observability/propagation';
import { createPropagator, createSampler } from '@/observability/tracing';

/**
 * The glue between the trace and the correlation id, against a real tracer.
 *
 * The middleware is only three effects — an attribute, a baggage entry, a
 * response header — and each of them is the kind of thing that is easy to write,
 * easy to believe, and impossible to notice the absence of until somebody is
 * holding a log line at 3am and cannot find the trace.
 */

const CORRELATION_ID = 'c0rr3l4t10n-1d-0001';

interface Fixture {
  readonly req: Request;
  readonly res: Response;
  readonly next: jest.Mock<void, []>;
  readonly headers: Record<string, string>;
}

/**
 * `null` for "no correlation id", not `undefined`.
 *
 * Passing `undefined` to a parameter with a default gets you the default, which
 * is the opposite of what such a call reads as — so the absent case would have
 * been tested with the id present and passed.
 */
function fixture(correlationId: string | null = CORRELATION_ID): Fixture {
  const headers: Record<string, string> = {};
  const req = {
    headers: correlationId === null ? {} : { 'x-correlation-id': correlationId },
  } as unknown as Request;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response;

  return { req, res, next: jest.fn<void, []>(), headers };
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
  tracer = trace.getTracer('trace.middleware.test');
});

afterEach(async () => {
  // Process-global state, and jest reuses a worker across files — see the same
  // note in `propagation.test.ts`.
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
  propagation.disable();
});

/**
 * Runs the middleware inside a server span, the way the `http` instrumentation
 * would have it: the span already exists by the time express dispatches
 * anything.
 */
function underServerSpan(run: (fx: Fixture) => void, fx: Fixture = fixture()): Fixture {
  const span = tracer.startSpan('GET /v1/users');
  context.with(trace.setSpan(context.active(), span), () => {
    run(fx);
  });
  span.end();
  return fx;
}

describe('traceContextMiddleware with an active span', () => {
  it('records the correlation id on the span', () => {
    // The attribute that makes the trace findable *from* a log line, which is
    // the direction people actually need.
    underServerSpan((fx) => {
      traceContextMiddleware(fx.req, fx.res, fx.next);
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes[CORRELATION_ID_ATTRIBUTE]).toBe(CORRELATION_ID);
  });

  it('publishes the trace id on the request for the access log', () => {
    const fx = underServerSpan((f) => {
      traceContextMiddleware(f.req, f.res, f.next);
    });

    const [span] = exporter.getFinishedSpans();
    expect(fx.req.traceId).toBe(span?.spanContext().traceId);
  });

  it('answers with a traceresponse naming this service span', () => {
    const fx = underServerSpan((f) => {
      traceContextMiddleware(f.req, f.res, f.next);
    });

    const [span] = exporter.getFinishedSpans();
    // The child id is *our* span, not the parent the caller sent: it is the span
    // a caller should attach to when it continues the trace.
    expect(fx.headers[TRACE_RESPONSE_HEADER]).toBe(
      `00-${span?.spanContext().traceId}-${span?.spanContext().spanId}-01`,
    );
  });

  it('puts the correlation id into baggage for the next hop', () => {
    let baggage: Baggage | undefined;

    underServerSpan((fx) => {
      fx.next.mockImplementation(() => {
        baggage = propagation.getActiveBaggage();
      });
      traceContextMiddleware(fx.req, fx.res, fx.next as unknown as NextFunction);
    });

    expect(baggage?.getEntry(CORRELATION_ID_BAGGAGE_KEY)?.value).toBe(CORRELATION_ID);
  });

  it('injects that baggage onto an outbound carrier', () => {
    // What the baggage entry is actually for. The assertion is on the wire
    // format rather than on the context, because an entry that never reaches the
    // `baggage` header is an entry that does nothing.
    let carrier: Record<string, string> = {};

    underServerSpan((fx) => {
      fx.next.mockImplementation(() => {
        carrier = injectTraceContext();
      });
      traceContextMiddleware(fx.req, fx.res, fx.next as unknown as NextFunction);
    });

    expect(carrier['baggage']).toContain(`${CORRELATION_ID_BAGGAGE_KEY}=${CORRELATION_ID}`);
    expect(carrier[TRACEPARENT_HEADER]).toBeDefined();
  });

  it('keeps an upstream baggage entry alongside its own', () => {
    // Dropping another service's entries here truncates them for everything
    // behind this one, and the symptom appears three hops away.
    const inbound = propagation.createBaggage({ tenant: { value: 'acme' } });
    let baggage: Baggage | undefined;

    const span = tracer.startSpan('GET /v1/users');
    const withInbound = propagation.setBaggage(
      trace.setSpan(context.active(), span),
      inbound,
    );
    const fx = fixture();
    fx.next.mockImplementation(() => {
      baggage = propagation.getActiveBaggage();
    });

    context.with(withInbound, () => {
      traceContextMiddleware(fx.req, fx.res, fx.next as unknown as NextFunction);
    });
    span.end();

    expect(baggage?.getEntry('tenant')?.value).toBe('acme');
    expect(baggage?.getEntry(CORRELATION_ID_BAGGAGE_KEY)?.value).toBe(CORRELATION_ID);
  });

  it('calls next exactly once', () => {
    const fx = underServerSpan((f) => {
      traceContextMiddleware(f.req, f.res, f.next);
    });

    expect(fx.next).toHaveBeenCalledTimes(1);
  });

  it('still answers and continues when no correlation id was minted', () => {
    // A request that reached here ahead of `correlationIdMiddleware`, or a
    // `Request` built by a test. The trace half of the work must not depend on
    // the correlation half.
    const fx = underServerSpan(
      (f) => {
        traceContextMiddleware(f.req, f.res, f.next);
      },
      fixture(null),
    );

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes[CORRELATION_ID_ATTRIBUTE]).toBeUndefined();
    expect(fx.headers[TRACE_RESPONSE_HEADER]).toBeDefined();
    expect(fx.req.traceId).toBeDefined();
    expect(fx.next).toHaveBeenCalledTimes(1);
  });
});

describe('traceContextMiddleware with no active span', () => {
  it('passes through without inventing identifiers', () => {
    // Tracing disabled, or a path `UNTRACED_PATHS` skips. The failure this
    // guards against is a `traceresponse` full of zeroes, which is a valid-looking
    // header pointing at a trace that does not exist.
    const fx = fixture();

    traceContextMiddleware(fx.req, fx.res, fx.next);

    expect(fx.headers).toEqual({});
    expect(fx.req.traceId).toBeUndefined();
    expect(fx.next).toHaveBeenCalledTimes(1);
  });
});

describe('formatTraceResponse', () => {
  it('reports the sampled flag as 01', () => {
    expect(
      formatTraceResponse({
        traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        spanId: '1122334455667788',
        sampled: true,
      }),
    ).toBe('00-a1b2c3d4e5f60718293a4b5c6d7e8f90-1122334455667788-01');
  });

  it('reports an unsampled trace as 00 rather than omitting the header', () => {
    // An unsampled trace still has an id, and a caller that logs it can still
    // ask the backend for it — some keep unsampled traces on the tail-based
    // decision of a collector further along.
    expect(
      formatTraceResponse({
        traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        spanId: '1122334455667788',
        sampled: false,
      }),
    ).toBe('00-a1b2c3d4e5f60718293a4b5c6d7e8f90-1122334455667788-00');
  });
});
