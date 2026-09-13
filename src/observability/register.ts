import { startTracing } from '@/observability/tracing';
import type { TracingHandle } from '@/observability/tracing';

/**
 * The tracing bootstrap, as a module whose *import position* is the contract.
 *
 * **This must be the first import of every entry point** — `server.ts`,
 * `scripts/stream-worker.ts`, `scripts/queue-worker.ts`. Not a style rule: every
 * instrumentation patches a module's exports as that module is loaded, through a
 * hook on `require`, and a module already in the cache is never offered to the
 * hook. Start the SDK after `express` has been required and it patches nothing,
 * reports no error, and produces no spans — the one failure mode that looks
 * exactly like a collector problem from every angle except this one.
 *
 * That is also why this is its own file rather than a call inside `server.ts`.
 * A `startTracing()` statement there would sit below `server.ts`'s own imports,
 * which include `@/app` and therefore express, because ES import declarations
 * are hoisted above every statement in the file. Only an import can run before
 * the other imports, so the bootstrap has to *be* one.
 *
 * Nothing else imports this. Application code that needs the tracing API goes
 * through `@/observability/propagation`, which pulls in `@opentelemetry/api` and
 * none of the SDK.
 */
export const tracing: TracingHandle = startTracing();

if (tracing.enabled) {
  // One line, at the only moment it is cheap to read, answering the question
  // that an absent trace always raises first. A deployment with tracing off
  // stays silent: a log line per process saying a disabled feature is disabled
  // is noise in every deployment that has made that choice on purpose.
  console.log('[tracing] OpenTelemetry started');
}
