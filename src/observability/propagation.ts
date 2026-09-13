import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Context, TextMapGetter, TextMapSetter } from '@opentelemetry/api';

/**
 * W3C trace context as a value, for the hops auto-instrumentation cannot see.
 *
 * The `http` instrumentation already injects `traceparent` on every outbound
 * request and extracts it from every inbound one, so a service whose only
 * boundaries are HTTP needs nothing from this file. What it does not cover is
 * every *other* boundary: a row in `outbox_messages` read back by a different
 * process minutes later, an entry on a Redis stream handed to a consumer in
 * another container, a BullMQ job. Each of those is a gap in the trace, and the
 * gap is exactly where the latency people are trying to explain tends to live.
 *
 * The carrier is a flat `Record<string, string>` because that is what all three
 * of those transports can already store — a `jsonb` column, a stream field, a
 * job's `data` — and because it is what the W3C propagators were written
 * against. Nothing here invents a header name or an encoding: the strings that
 * come out are the same `traceparent`, `tracestate` and `baggage` that go over
 * the wire, which is what lets a consumer in another language read them.
 */

/** The W3C header names, exported because carriers and tests assert on them. */
export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';
export const BAGGAGE_HEADER = 'baggage';

/**
 * A carrier as it is stored and read back.
 *
 * Mutable on purpose: `propagation.inject` writes into it through the setter
 * below, and a `Readonly` here would push the cast into `injectTraceContext`
 * where it would be doing the same thing with less to say for itself.
 */
export type TraceCarrier = Record<string, string>;

/**
 * Reads a carrier key without caring how it was capitalised.
 *
 * The spec says the header names are lowercase and Node lowercases inbound HTTP
 * headers, so this looks like defensiveness for its own sake. It is not: a
 * carrier here is as likely to have been *written* by another service's client
 * library into a message body, and several write `Traceparent`. The failure that
 * produces is the worst kind available — a propagator that finds no parent does
 * not error, it silently starts a new trace, and the symptom is two
 * disconnected traces in a UI with nothing to say they belong together.
 *
 * The exact-match fast path is first because it is the case that actually
 * happens; the scan only runs for a carrier that has already missed.
 */
const carrierGetter: TextMapGetter<TraceCarrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => {
    const exact = carrier[key];
    if (exact !== undefined) return exact;

    const wanted = key.toLowerCase();
    for (const [name, value] of Object.entries(carrier)) {
      if (name.toLowerCase() === wanted) return value;
    }
    return undefined;
  },
};

const carrierSetter: TextMapSetter<TraceCarrier> = {
  set: (carrier, key, value) => {
    carrier[key] = value;
  },
};

/**
 * The active trace context as a carrier, ready to be stored alongside a message.
 *
 * **An empty object is a correct answer, not a failure.** The W3C propagator
 * writes nothing when there is no valid span to describe — tracing disabled, or
 * a code path with no active span, such as a startup task. A caller that treats
 * `{}` as an error ends up either throwing during boot or writing a
 * syntactically valid `traceparent` with a zeroed trace id, which every backend
 * rejects and no backend explains.
 *
 * Whether `baggage` appears depends on whether anything put any there; see
 * `withCorrelationBaggage`.
 */
export function injectTraceContext(ctx: Context = context.active()): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(ctx, carrier, carrierSetter);
  return carrier;
}

/**
 * A stored carrier back to a context whose active span is the remote parent.
 *
 * Based on `ROOT_CONTEXT` rather than on whatever is active, and that default is
 * the whole reason this is a named function instead of a call to
 * `propagation.extract`. A consumer is always running inside *something* — a
 * poll loop, a relay tick, a job runner — and each of those may well have a span
 * of its own. Extracting onto the active context means a carrier with no
 * `traceparent` in it quietly inherits that span as its parent, so every message
 * a worker handles hangs off the poll that happened to pick it up and the
 * producer's trace is lost. Rooting it here makes the absence of a
 * `traceparent` produce what it should: a new trace.
 *
 * The relationship to the consuming loop is a *link* rather than a parent, which
 * is what links are for — pass `{ links: [{ context: pollSpanContext }] }` when
 * starting the span if that edge is worth recording.
 */
export function extractTraceContext(carrier: TraceCarrier): Context {
  return propagation.extract(ROOT_CONTEXT, carrier, carrierGetter);
}

/**
 * Runs `body` with the carrier's trace context active.
 *
 * The shape a consumer wants: everything the handler does — spans it starts,
 * queries the `pg` instrumentation traces, calls it makes onward — lands under
 * the producer's trace without the handler being aware of any of it.
 */
export function withTraceContext<T>(carrier: TraceCarrier, body: () => T): T {
  return context.with(extractTraceContext(carrier), body);
}

/** The identifying half of a span context — what a log line wants. */
export interface ActiveTrace {
  readonly traceId: string;
  readonly spanId: string;
  /** The `sampled` flag as the upstream set it, not a local decision. */
  readonly sampled: boolean;
}

/**
 * The ids of the currently active span, or `undefined` when there is no trace.
 *
 * `undefined` in three genuinely different situations — tracing disabled, no
 * active span, or a span whose context is invalid — and deliberately not
 * distinguished, because every caller wants the same thing from all three: a
 * log line that says `-` and moves on. Distinguishing them would mean asking a
 * request logger to care about the state of the SDK.
 */
export function activeTraceContext(ctx: Context = context.active()): ActiveTrace | undefined {
  const spanContext = trace.getSpanContext(ctx);
  if (spanContext === undefined) return undefined;
  if (!trace.isSpanContextValid(spanContext)) return undefined;

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    // `traceFlags` is a bit field and `sampled` is bit 0. Read with a mask
    // rather than `=== 1`, so a future flag being set alongside it does not turn
    // a sampled span into an unsampled one.
    sampled: (spanContext.traceFlags & 1) === 1,
  };
}
