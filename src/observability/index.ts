/**
 * The observability barrel — and deliberately not a re-export of `register.ts`.
 *
 * `register.ts` starts the SDK as a side effect of being imported, and its whole
 * correctness argument is about *when* that happens. Re-exporting it here would
 * make `import { something } from '@/observability'` bootstrap tracing from
 * wherever that import happened to sit, which is the ordering bug this design
 * exists to prevent. Entry points import `@/observability/register` by its own
 * path, where the line is visible and its position is reviewable.
 */
export {
  BAGGAGE_HEADER,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  activeTraceContext,
  extractTraceContext,
  injectTraceContext,
  withTraceContext,
} from '@/observability/propagation';
export type { ActiveTrace, TraceCarrier } from '@/observability/propagation';

export {
  CORRELATION_ID_ATTRIBUTE,
  CORRELATION_ID_BAGGAGE_KEY,
  TRACE_RESPONSE_HEADER,
  formatTraceResponse,
  traceContextMiddleware,
} from '@/observability/trace.middleware';

export {
  UNTRACED_PATHS,
  otlpTracesUrl,
  resolveTracingConfig,
  shouldTracePath,
  startTracing,
} from '@/observability/tracing';
export type { TracingConfig, TracingEnv, TracingHandle } from '@/observability/tracing';

export { TRACES_EXPORTERS } from '@/observability/tracing.types';
export type { TracesExporter } from '@/observability/tracing.types';
