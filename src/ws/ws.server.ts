import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { authenticateHandshake, millisecondsUntilExpiry } from '@/ws/handshake';
import type { HandshakeOptions } from '@/ws/handshake';
import { createWsConnection } from '@/ws/connection';
import type { WsConnection, WsRateLimitOptions } from '@/ws/connection';
import { WS_CLOSE } from '@/ws/ws.close';

/**
 * The WebSocket endpoint, attached to the same `http.Server` that serves the
 * REST API.
 *
 * One server and one port rather than two, because a WebSocket connection
 * *starts* as an HTTP request: the client GETs the path with `Upgrade:
 * websocket`, and only after the 101 does the socket stop speaking HTTP. A
 * second listener would need its own port, its own TLS termination, its own
 * ingress rule and its own health check, to serve a handshake this one already
 * receives.
 *
 * One consequence of owning that event: this attachment answers *every*
 * upgrade the server receives, refusing the paths it does not serve with 404.
 * A listener that quietly ignored them would leak the socket — Node only
 * destroys an unhandled upgrade when the server has no listener at all — so a
 * deployment with two WebSocket paths attaches once and branches inside rather
 * than stacking two listeners. `close()` removes the listener again.
 *
 * `noServer: true` is the important flag, and it is not a detail. The
 * alternative — handing `ws` the HTTP server and letting it own the `upgrade`
 * event — leaves rejection to `verifyClient`, which can refuse a connection but
 * cannot say anything useful while doing it: the client gets a bare status with
 * no body, and `ws` has deprecated the option for exactly that reason. Owning
 * the `upgrade` listener means an unauthenticated handshake is answered with a
 * real HTTP response carrying the same JSON error envelope every REST route
 * uses, which is the difference between a client that logs "401 UNAUTHORIZED,
 * missing access token" and one that logs "connection closed".
 */

export interface WsServerOptions {
  /** The path the upgrade must target. Other paths are left for other listeners. */
  readonly path: string;

  /** Concurrent sockets this process will hold. Enforced before the upgrade. */
  readonly maxConnections: number;

  /**
   * The largest frame `ws` will reassemble, in bytes.
   *
   * The only real bound on inbound memory, and it has to be here rather than in
   * the connection: a message handler runs after `ws` has already buffered the
   * whole frame, so an application-level size check cannot prevent a peer from
   * sending a 500 MB message — it can only complain about one that already
   * arrived. Above this, `ws` refuses during reassembly and closes with 1009.
   */
  readonly maxPayloadBytes: number;

  readonly rateLimit: WsRateLimitOptions;
  readonly heartbeatIntervalMs: number;
  readonly maxBufferedBytes: number;
  readonly allowedOrigins: HandshakeOptions['allowedOrigins'];

  /** Handles one admitted text frame. See `WsConnectionOptions.onMessage`. */
  readonly onMessage: (message: string, connection: WsConnection) => void | Promise<void>;

  /** Called once per accepted socket, after it is registered. For a subscribe-on-open protocol. */
  readonly onConnection?: (connection: WsConnection) => void;
}

export interface WsServerHandle {
  readonly connectionCount: number;
  /** Sends to every open connection. Returns how many accepted the frame. */
  broadcast(payload: unknown): number;
  /** Closes every connection and stops accepting upgrades. For shutdown and test teardown. */
  close(): Promise<void>;
}

/**
 * Writes an HTTP response onto a socket that is still speaking HTTP, then ends
 * it.
 *
 * This is the pre-101 path, and the socket here is a raw `Duplex` — the
 * `ServerResponse` never existed, because the `upgrade` event fires instead of
 * `request`. So the status line and headers are written by hand. `Connection:
 * close` matters: without it a keep-alive client waits for a second response on
 * a socket that is about to disappear.
 */
function refuseUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ data: null, meta: null, error: { code, message } });
  const statusText = STATUS_TEXT[status] ?? 'Error';

  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body,
  );
  socket.destroy();
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

export function attachWebSocketServer(
  httpServer: HttpServer,
  options: WsServerOptions,
): WsServerHandle {
  const {
    path,
    maxConnections,
    maxPayloadBytes,
    rateLimit,
    heartbeatIntervalMs,
    maxBufferedBytes,
    allowedOrigins,
    onMessage,
    onConnection,
  } = options;

  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new RangeError(
      `attachWebSocketServer: maxConnections must be an integer >= 1, received ${maxConnections}`,
    );
  }

  const wss = new WebSocketServer({
    // See the module comment: we own the `upgrade` event so a refusal can be an
    // HTTP response rather than a silent socket destruction.
    noServer: true,
    maxPayload: maxPayloadBytes,
    // `perMessageDeflate` stays off, which is also `ws`'s default and is worth
    // stating rather than inheriting. Enabling it allocates a zlib context per
    // connection — hundreds of kilobytes each, far more than the socket itself
    // — so it converts a connection flood into a memory exhaustion, and it
    // makes compressed traffic a CPU amplifier. It is worth turning on for a
    // small number of connections carrying large repetitive payloads, and
    // nothing else.
    perMessageDeflate: false,
  });

  const connections = new Set<WsConnection>();
  let closing = false;

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // `req.url` on an upgrade is origin-form ("/v1/ws?x=1"), so it needs a base
    // to parse. The base is discarded — only the pathname is read.
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) {
      // Answered rather than ignored, and that is not a stylistic choice.
      //
      // Node destroys an upgrade socket only when the server has *no* `upgrade`
      // listener at all. Once this one is attached the event counts as handled,
      // so a listener that returns without touching the socket leaks it: the
      // client waits for a handshake that will never come, the server holds the
      // connection until a TCP timeout that may never fire, and `server.close()`
      // waits for it forever — which turns a graceful shutdown into a `SIGKILL`.
      //
      // The consequence is that this attachment owns the `upgrade` event for
      // the server it is given. A deployment serving two WebSocket paths should
      // attach once and branch inside, not stack two listeners.
      refuseUpgrade(socket, 404, 'NOT_FOUND', `No WebSocket endpoint at ${url.pathname}`);
      return;
    }

    if (closing) {
      refuseUpgrade(socket, 503, 'SERVER_SHUTTING_DOWN', 'This instance is shutting down');
      return;
    }

    if (connections.size >= maxConnections) {
      // 503 and not 429: the client has done nothing wrong and slowing down
      // will not help — this instance is full.
      refuseUpgrade(
        socket,
        503,
        'WS_CAPACITY_EXHAUSTED',
        `This instance is already serving its maximum of ${maxConnections} WebSocket connections`,
      );
      return;
    }

    const verdict = authenticateHandshake(req, { allowedOrigins });
    if (!verdict.ok) {
      refuseUpgrade(socket, verdict.status, verdict.code, verdict.message);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // The capacity check above happened before an `await`-free stretch, but
      // `handleUpgrade` completes the handshake asynchronously, so two
      // simultaneous upgrades can both pass it. Re-checking here is what makes
      // the ceiling exact rather than approximate; the client is closed rather
      // than refused because the 101 has already been sent.
      if (connections.size >= maxConnections) {
        ws.close(WS_CLOSE.GOING_AWAY, 'Capacity exhausted');
        return;
      }

      const connection = createWsConnection(ws, {
        principal: verdict.principal,
        rateLimit,
        heartbeatIntervalMs,
        maxBufferedBytes,
        expiresInMs: millisecondsUntilExpiry(verdict.principal),
        onMessage,
      });

      connections.add(connection);
      connection.onClose(() => {
        connections.delete(connection);
      });

      onConnection?.(connection);
    });
  }

  httpServer.on('upgrade', handleUpgrade);

  return {
    get connectionCount(): number {
      return connections.size;
    },

    broadcast(payload: unknown): number {
      let delivered = 0;
      // Iterating a copy: `send` can close a slow consumer, which deletes from
      // the set being walked.
      for (const connection of [...connections]) {
        if (connection.send(payload)) delivered += 1;
      }
      return delivered;
    },

    async close(): Promise<void> {
      closing = true;
      httpServer.off('upgrade', handleUpgrade);

      for (const connection of [...connections]) {
        connection.close(WS_CLOSE.GOING_AWAY, 'Server shutting down');
      }
      connections.clear();

      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
  };
}
