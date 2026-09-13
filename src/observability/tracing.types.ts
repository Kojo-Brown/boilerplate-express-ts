/**
 * The exporter names, in a leaf module so `env` can validate against them.
 *
 * Separated from `tracing.ts` for the same reason `storage.types.ts` is
 * separated from the registry: `tracing.ts` reads `env`, so an import the other
 * way round would be a cycle — and the alternative, a second copy of the list
 * inside the schema, is the one that goes stale and accepts a value nothing
 * handles.
 *
 * The names are OpenTelemetry's own (`OTEL_TRACES_EXPORTER` takes exactly these
 * words) rather than invented, so an operator who has configured a collector
 * before does not have to learn this service's vocabulary for it.
 */
export const TRACES_EXPORTERS = ['none', 'console', 'otlp'] as const;

export type TracesExporter = (typeof TRACES_EXPORTERS)[number];
