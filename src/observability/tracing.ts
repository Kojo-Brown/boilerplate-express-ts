import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { TextMapPropagator } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { env } from '@/config/env';
// A leaf module with no side effects, which is a requirement and not a
// coincidence: this file is reached from `observability/register.ts`, whose
// whole contract is that it loads before express, pg and ioredis do.
import { matchesAnyPath } from '@/lib/path-prefix';
import type { TracesExporter } from '@/observability/tracing.types';

/**
 * The tracing SDK: what is instrumented, how a trace is sampled, where spans go.
 *
 * Nothing in this file is imported by application code. That is the design, not
 * an accident of layering — the whole value of auto-instrumentation is that
 * `usersRouter` does not mention a span, and a codebase that starts passing a
 * tracer around has given that up. The two places that *do* reach for the
 * tracing API are `propagation.ts`, for the boundaries no instrumentation can
 * see, and `trace.middleware.ts`, to tie a trace to the correlation id this
 * service already had.
 *
 * ## Why this cannot be started from `createApp`
 *
 * Every instrumentation here works by replacing exported functions on a module
 * — `http.request`, `express.Router`, `pg.Client.prototype.query` — when that
 * module is loaded, through a hook on `require`. A module already in the cache
 * is never handed to the hook, so an SDK started after `import express from
 * 'express'` patches nothing and produces no spans at all, silently. Hence
 * `register.ts`, and hence its being the *first* import in every entry point.
 */

/**
 * Request paths that never produce a trace.
 *
 * A readiness probe is the highest-volume endpoint most services have — a
 * kubelet at one second per replica outnumbers real traffic in anything but a
 * busy API — and each of its traces is one span saying 200. Left in, it is the
 * bulk of the export bill and the bulk of what a sampled trace is spent on.
 *
 * Dropped at the `http` instrumentation rather than by the sampler on purpose:
 * an unsampled span is still created, still costs a context, and still has to be
 * carried to the sampler. `ignoreIncomingRequestHook` runs before any of that.
 *
 * The metrics exposition is here for a different reason and the same effect: a
 * scrape is a fixed-rate GET that reads three counters, so tracing it produces
 * one identical span every fifteen seconds forever. It also makes the export
 * bill a function of the scrape interval, which is a knob nobody expects to be
 * connected to tracing.
 *
 * Both entries are *subtrees*: `/v1/health` is a router, and `/live` and
 * `/ready` beneath it are the paths a kubelet is actually pointed at — an
 * exclusion that stopped at the root would cover the alias and export a span
 * per probe for the two endpoints doing the polling. Matching is segment aware,
 * so the prefix cannot swallow `/v1/healthcheck-admin`; see `isUnderPath`.
 */
export const UNTRACED_PATHS: readonly string[] = ['/v1/health', env.METRICS_PATH];

/**
 * `deployment.environment.name`, spelled out rather than imported.
 *
 * The constant for it (`ATTR_DEPLOYMENT_ENVIRONMENT_NAME`) lives in the
 * `semantic-conventions/incubating` entry point, which is declared through an
 * `exports` map — and this project compiles with `moduleResolution: "node"`,
 * which predates those and cannot resolve the subpath. The two alternatives are
 * worse than a literal: widening the whole project's module resolution for one
 * string, or importing `@opentelemetry/semantic-conventions/build/src/…`, which
 * pins a path inside a dependency's build output that no semver promise covers.
 *
 * The name is the newer of the two — `deployment.environment` was renamed — and
 * it is what separates staging's traces from production's in any backend that
 * groups by it.
 */
export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

export interface TracingConfig {
  /**
   * Whether the SDK is started at all.
   *
   * False also for `exporter: 'none'`, which is the case worth naming: a tracer
   * with nowhere to send spans is not a cheap tracer. It patches every
   * instrumented module, builds a span per request and per query, and discards
   * the lot. Off means off.
   */
  readonly enabled: boolean;
  readonly serviceName: string;
  /** Omitted from the resource when empty rather than reported as `''`. */
  readonly serviceVersion: string | undefined;
  readonly environment: string;
  readonly exporter: TracesExporter;
  /** The full traces URL, already derived from the base endpoint. */
  readonly otlpUrl: string | undefined;
  readonly sampleRatio: number;
}

/**
 * The base OTLP endpoint to the URL the traces exporter actually posts to.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is defined by the spec as a *base* — the path
 * `/v1/traces` is the protocol's, not the operator's — but the variable is
 * copied between config systems by people reading exporter docs, and half of
 * those docs show the full path. Accepting both is the difference between a
 * wrong value and a collector that returns 404 to every export while the service
 * itself looks entirely healthy.
 */
export function otlpTracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

/** Whether an inbound request path is traced. Exported for the hook and its test. */
export function shouldTracePath(path: string | undefined): boolean {
  if (path === undefined) return true;
  // Compared against the path alone: `/v1/health?probe=readiness` is the same
  // endpoint, and a query string is something a prober can add at any time.
  const pathname = path.split('?')[0] ?? path;
  // Subtree and not equality: `/v1/health` is a router now, and `/live` and
  // `/ready` under it are polled harder than the alias at its root. Segment
  // aware, so `/v1/healthcheck-admin` keeps its traces — see `isUnderPath`.
  return !matchesAnyPath(pathname, UNTRACED_PATHS);
}

/** The settings this file reads, named so a test can supply them without `env`. */
export interface TracingEnv {
  readonly NODE_ENV: string;
  readonly OTEL_SDK_DISABLED: boolean;
  readonly OTEL_SERVICE_NAME: string;
  readonly OTEL_SERVICE_VERSION: string;
  readonly OTEL_TRACES_EXPORTER: TracesExporter;
  readonly OTEL_EXPORTER_OTLP_ENDPOINT: string;
  readonly OTEL_TRACES_SAMPLER_ARG: number;
}

export function resolveTracingConfig(source: TracingEnv): TracingConfig {
  const exporter = source.OTEL_SDK_DISABLED ? 'none' : source.OTEL_TRACES_EXPORTER;

  return {
    enabled: exporter !== 'none',
    serviceName: source.OTEL_SERVICE_NAME,
    serviceVersion: source.OTEL_SERVICE_VERSION === '' ? undefined : source.OTEL_SERVICE_VERSION,
    environment: source.NODE_ENV,
    exporter,
    otlpUrl:
      exporter === 'otlp' ? otlpTracesUrl(source.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined,
    sampleRatio: source.OTEL_TRACES_SAMPLER_ARG,
  };
}

/**
 * Parent-based over the ratio, and the nesting is the entire point.
 *
 * A ratio sampler asked at every hop *multiplies*: four services at 0.1 each
 * keep one trace in ten thousand whole, and the ones that survive are chosen
 * independently of whether anything went wrong. Worse, the traces that do not
 * survive are not absent — they are present in fragments, one service at a time,
 * which is how a trace comes to show a 900ms gap with nothing in it.
 *
 * `ParentBasedSampler` defers to the `sampled` flag on the inbound
 * `traceparent`, so the decision is made once, by whoever started the trace, and
 * honoured unchanged by everyone downstream. The ratio only ever applies to a
 * *root* span — a request this service received without a trace context, or work
 * it started on a timer — which is the only place a decision is ours to make.
 */
export function createSampler(sampleRatio: number): Sampler {
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) });
}

/**
 * W3C `traceparent`/`tracestate` and W3C `baggage`, pinned here rather than left
 * to `OTEL_PROPAGATORS`.
 *
 * This composite is also the SDK's default, so the line looks redundant. What it
 * buys is that the wire format is no longer an environment variable: a
 * deployment cannot be switched to B3 or to Jaeger's header by a value in a
 * config map, and it cannot lose `baggage` by setting `OTEL_PROPAGATORS` to
 * `tracecontext` and not realising the variable replaces the whole list rather
 * than adding to it. Either change breaks correlation with every other service
 * in the mesh while this one keeps producing perfectly valid traces of its own,
 * which is a bad failure to debug from the outside.
 *
 * A deployment that genuinely needs a second format — one legacy peer emitting
 * B3 — adds it here, in a diff, where the choice is reviewable.
 */
export function createPropagator(): TextMapPropagator {
  return new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });
}

/**
 * `console` gets a simple processor and `otlp` a batching one, deliberately.
 *
 * Batching is right for a network exporter and wrong for a console: the point of
 * printing spans is to see them while reproducing something, and a batch
 * delayed by five seconds arrives after the developer has moved on. The cost of
 * `SimpleSpanProcessor` — an export call per span, inline — is what makes it
 * unusable in production and irrelevant at a terminal.
 */
export function createSpanProcessor(config: TracingConfig): SpanProcessor | undefined {
  if (config.exporter === 'console') return new SimpleSpanProcessor(new ConsoleSpanExporter());
  if (config.exporter === 'otlp') {
    if (config.otlpUrl === undefined) {
      // Unreachable through `resolveTracingConfig`, and refused at boot by the
      // env invariant besides. Kept as a throw rather than a silent fallback
      // because the fallback — export to nowhere — is the failure this service
      // would then be unable to report.
      throw new Error('tracing: exporter "otlp" requires OTEL_EXPORTER_OTLP_ENDPOINT');
    }
    return new BatchSpanProcessor(new OTLPTraceExporter({ url: config.otlpUrl }));
  }
  return undefined;
}

/**
 * The instrumentations, with the noisy ones off.
 *
 * `fs` is the one that matters. On it, every `require`, every static file read
 * and every `readFileSync` a dependency performs becomes a span — thousands per
 * request in the worst case — and the request's own span is buried in a trace no
 * UI can render. It is disabled in most production deployments and enabling it
 * is a deliberate act for a specific investigation.
 *
 * `dns` and `net` go for a milder version of the same reason: under a connection
 * pool they describe the pool's behaviour rather than the request's, and the
 * `http` and `pg` spans already carry the peer that matters.
 *
 * Everything else stays on, which is the point of the package — `http`,
 * `express`, `pg`, `ioredis` and the AWS SDK cover every boundary this service
 * has except the store-and-forward ones, and those are `propagation.ts`.
 */
export function createInstrumentations(): ReturnType<typeof getNodeAutoInstrumentations> {
  return getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-http': {
      ignoreIncomingRequestHook: (request) => !shouldTracePath(request.url),
    },
  });
}

export interface TracingHandle {
  readonly enabled: boolean;
  /**
   * Flushes what the processor is holding and stops the SDK.
   *
   * Awaited during shutdown and worth awaiting: a `BatchSpanProcessor` holds
   * finished spans for up to its scheduled delay, so a process that exits
   * without this loses the spans of the last requests it served — which, during
   * a bad deploy, are the only ones anybody wants.
   */
  shutdown: () => Promise<void>;
}

const DISABLED: TracingHandle = { enabled: false, shutdown: () => Promise.resolve() };

/**
 * Builds and starts the SDK, or does nothing.
 *
 * Returns a handle either way so the caller's shutdown sequence does not need a
 * branch — see `server.ts`, where the tracing task is unconditional and is a
 * no-op in every deployment that has tracing off.
 */
export function startTracing(config: TracingConfig = resolveTracingConfig(env)): TracingHandle {
  if (!config.enabled) return DISABLED;

  const processor = createSpanProcessor(config);
  if (processor === undefined) return DISABLED;

  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
  };
  if (config.serviceVersion !== undefined) {
    attributes[ATTR_SERVICE_VERSION] = config.serviceVersion;
  }

  const sdk = new NodeSDK({
    // Merged onto the default resource rather than replacing it, so the host,
    // process and container attributes the detectors find are kept. Replacing it
    // is the usual mistake and it costs the `service.instance.id` that tells two
    // replicas apart.
    resource: defaultResource().merge(resourceFromAttributes(attributes)),
    sampler: createSampler(config.sampleRatio),
    textMapPropagator: createPropagator(),
    spanProcessors: [processor],
    instrumentations: createInstrumentations(),
  });

  sdk.start();

  return {
    enabled: true,
    shutdown: () => sdk.shutdown(),
  };
}
