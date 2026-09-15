import { collectDefaultMetrics } from '@prometheus-io/client';
import type { Registry } from '@prometheus-io/client';

/**
 * The Node and process collectors: heap, RSS, file descriptors, GC pauses,
 * event-loop lag and utilisation.
 *
 * USE rather than RED — they describe the machine this service runs on, not the
 * requests it serves — and they are here because half of the investigations
 * that start on a RED dashboard end on these. "Every route got slower at once
 * and none of them changed" has one of two answers, and `nodejs_eventloop_lag`
 * and `nodejs_heap_size_used_bytes` are both of them.
 *
 * All of it is pull-based: the collectors run during `registry.metrics()`, so
 * there is no interval, no timer and nothing to stop. That is what makes
 * starting them idempotent-ish and cheap, and it is also why this function has
 * no counterpart in the shutdown sequence.
 */

/**
 * Registers the collectors on `registry`.
 *
 * Called from `server.ts` and not from `createApp`, which is the same rule the
 * purge job and the outbox relay follow: what is being described is the
 * *process*, and every e2e suite builds an app. A suite that acquired a
 * process-wide collector would be measuring Jest.
 *
 * Calling it twice on one registry throws — the client refuses to register a
 * metric name that is already there — and that is left as a throw rather than
 * guarded. A second call means two places believe they own this, which is worth
 * a stack trace at boot instead of a silent winner.
 */
export function startProcessMetrics(registry: Registry): void {
  collectDefaultMetrics({ register: registry });
}
