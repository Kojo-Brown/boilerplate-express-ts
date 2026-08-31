import { env } from '@/config/env';
import { createSseHub } from '@/sse/hub';
import type { SseHub } from '@/sse/hub';

/**
 * The process-wide hub the `/v1/events/stream` route serves from.
 *
 * A singleton for the same reason `domainEventBus` is one: it is the fan-out
 * point, and two of them would be two disjoint sets of subscribers each seeing
 * half the events. The subscription to the bus is *not* made here — it is made
 * in the composition root, so a deployment can leave the feed off without
 * losing the hub, and so a test can attach its own.
 *
 * Kept in its own module rather than in `hub.ts` so that the factory stays free
 * of `env`: every test in `hub.test.ts` builds a hub with its own bounds.
 */
export const domainEventStreamHub: SseHub = createSseHub({
  replayBufferSize: env.SSE_REPLAY_BUFFER_SIZE,
  maxConnections: env.SSE_MAX_CONNECTIONS,
});
