import { context, propagation, trace } from '@opentelemetry/api';
import type { Request, Response, NextFunction } from 'express';
import { correlationIdOf } from '@/middleware/logger.middleware';
import { activeTraceContext } from '@/observability/propagation';
import type { ActiveTrace } from '@/observability/propagation';

/**
 * The one place application code meets the tracing API, and it exists to join
 * the trace to the identifiers this service already had.
 *
 * Auto-instrumentation produces a complete trace that shares no identifier with
 * anything in the logs, and a correlation id identifies a request that appears
 * in no trace. Both are true and neither is useful: during an incident somebody
 * has a log line and needs the trace, or has the slow trace and needs the log
 * lines. Three lines of glue — an attribute, a baggage entry and a response
 * header — are what make either direction a lookup instead of a guess.
 *
 * Must run *after* `correlationIdMiddleware`, which is what mints the id, and
 * before the routers, so the baggage is set for everything the request goes on
 * to do. See the ordering comments in `app.ts`.
 */

/**
 * The span attribute the correlation id is recorded under.
 *
 * `app.` prefixed because the semantic conventions reserve the unprefixed
 * namespaces and there is no standard attribute for this: the nearest,
 * `session.id`, means something else. A private prefix is the convention's own
 * advice for a private attribute.
 */
export const CORRELATION_ID_ATTRIBUTE = 'app.correlation_id';

/**
 * The W3C baggage key the correlation id travels under.
 *
 * Baggage reaches *every* downstream service and shows up in their logs and
 * their spans, so the rule about what may go in it is narrow and worth stating
 * where the only entry is added: an opaque id this service generated, never a
 * user id, an email, a token or anything else that would then be duplicated into
 * systems that never asked for it and cannot delete it. The header is also part
 * of every outbound request's size budget, which is the second reason the list
 * stays at one entry.
 */
export const CORRELATION_ID_BAGGAGE_KEY = 'correlation_id';

/**
 * The response header carrying the trace this request was served under.
 *
 * `traceresponse` is W3C Trace Context Level 2, which is still a draft — so this
 * is a deliberate bet on a name rather than a settled standard. It is a cheap
 * bet: a response header is advisory, a client that has never heard of it ignores
 * it, and nothing in this service reads it back. What it buys is the direction of
 * lookup that is otherwise impossible — a caller holding a failed response can
 * name the trace id to search for, without this service having to log every
 * request's trace id on the off chance somebody asks.
 */
export const TRACE_RESPONSE_HEADER = 'traceresponse';

/**
 * The `traceresponse` value: the same field layout as `traceparent`.
 *
 * Version `00`, the trace id, *this* service's span id — the draft calls it the
 * child id, and it is the span the caller should attach to, not the parent it
 * sent us — and the flags byte. The flags are rebuilt from the sampled bit
 * rather than echoed, so a future flag we do not understand is not asserted back
 * at the caller as though we had honoured it.
 */
export function formatTraceResponse(active: ActiveTrace): string {
  return `00-${active.traceId}-${active.spanId}-${active.sampled ? '01' : '00'}`;
}

export function traceContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const active = activeTraceContext();

  // No trace: tracing is off, or this path is one `UNTRACED_PATHS` skips. Every
  // line below would be describing a span that does not exist, so the middleware
  // becomes a pass-through rather than a source of `00000000...` identifiers.
  if (active === undefined) {
    next();
    return;
  }

  // Read from the request rather than recomputed here: an id minted in this file
  // would be one that appears in a span and in no access log, which reads like a
  // lost request. `correlationIdOf` returns `undefined` for the same reason.
  const correlationId = correlationIdOf(req);

  // Recorded on the span before anything else, because this is the attribute
  // that makes the trace findable from a log line, and an early `return` below
  // must not be able to cost it.
  const span = trace.getActiveSpan();
  if (span !== undefined && correlationId !== undefined) {
    span.setAttribute(CORRELATION_ID_ATTRIBUTE, correlationId);
  }

  req.traceId = active.traceId;
  res.setHeader(TRACE_RESPONSE_HEADER, formatTraceResponse(active));

  if (correlationId === undefined) {
    next();
    return;
  }

  // Merged into the inbound baggage rather than replacing it. An upstream's
  // entries are its business — a tenant, an experiment arm, a debug flag — and
  // dropping them here truncates them for every service behind this one, which
  // is a failure that appears to originate three hops away.
  const inbound = propagation.getActiveBaggage() ?? propagation.createBaggage();
  const baggage = inbound.setEntry(CORRELATION_ID_BAGGAGE_KEY, { value: correlationId });

  // `context.with` and not a bare `next()`: the baggage has to be *active* for
  // the rest of the chain, since that is how the propagator finds it when the
  // outbound `http` instrumentation injects headers. Express dispatches the
  // remaining middleware synchronously from inside this call, and every `await`
  // after that keeps the context through `AsyncLocalStorage`.
  context.with(propagation.setBaggage(context.active(), baggage), next);
}
