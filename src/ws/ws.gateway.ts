import type { Server as HttpServer } from 'node:http';
import { env } from '@/config/env';
import { attachWebSocketServer } from '@/ws/ws.server';
import type { WsServerHandle } from '@/ws/ws.server';
import { handleClientFrame } from '@/ws/ws.protocol';

/**
 * The endpoint as this deployment configures it, kept apart from the factory
 * that builds one.
 *
 * Same split as `sse/events.hub.ts` and for the same reason: `ws.server.ts`
 * never reads `env`, so every test in this directory constructs a server with
 * its own bounds instead of inheriting a thousand-connection ceiling it has no
 * intention of reaching.
 */

/**
 * Browser origins allowed to open a socket, or `null` for any.
 *
 * `CORS_ORIGIN` is the fallback rather than a separate default because the two
 * answer the same question — which page is allowed to talk to this API — and a
 * deployment that has already answered it once should not have to answer it
 * again to avoid accidentally allowing every origin. `*` is spelled out
 * explicitly, so allowing everything is a decision in the environment rather
 * than the consequence of leaving a variable blank.
 */
export function wsAllowedOrigins(): readonly string[] | null {
  const configured = env.WS_ALLOWED_ORIGINS.trim() === '' ? env.CORS_ORIGIN : env.WS_ALLOWED_ORIGINS;
  if (configured.trim() === '*') return null;

  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Attaches `/v1/ws` to the process's HTTP server.
 *
 * Called from `server.ts` and nowhere else, for the same reason the outbox
 * relay and the purge job are: an e2e suite that builds an app should not
 * acquire a port's worth of long-lived sockets. The suites that do exercise
 * this call `attachWebSocketServer` against a server they own and close.
 */
export function attachDomainWebSocketServer(httpServer: HttpServer): WsServerHandle {
  return attachWebSocketServer(httpServer, {
    path: env.WS_PATH,
    maxConnections: env.WS_MAX_CONNECTIONS,
    maxPayloadBytes: env.WS_MAX_PAYLOAD_BYTES,
    heartbeatIntervalMs: env.WS_HEARTBEAT_INTERVAL_MS,
    maxBufferedBytes: env.WS_MAX_BUFFERED_BYTES,
    allowedOrigins: wsAllowedOrigins(),
    rateLimit: {
      burst: env.WS_RATE_LIMIT_BURST,
      messagesPerSecond: env.WS_RATE_LIMIT_MESSAGES_PER_SECOND,
      bytesPerSecond: env.WS_RATE_LIMIT_BYTES_PER_SECOND,
      // The per-connection ceiling is the server's reassembly limit: a frame
      // larger than `maxPayload` never reaches a handler, so a different number
      // here would describe a case that cannot occur. They are separate options
      // on the two modules so a future per-principal limit can lower this one
      // without reconfiguring the server.
      maxMessageBytes: env.WS_MAX_PAYLOAD_BYTES,
    },
    onMessage: handleClientFrame,
  });
}
