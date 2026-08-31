import type { Request, Response } from 'express';
import { encodeComment, encodeFrame, encodeRetry } from '@/sse/frame';
import type { StreamMessage } from '@/sse/event-log';

/**
 * One open `text/event-stream` response, and everything that has to be true for
 * it to still be open in an hour.
 *
 * This is the only module here that holds a `Response`. Everything above it —
 * the log, the hub, the domain feed — deals in `StreamMessage` values, which is
 * what lets a fan-out of one event to two hundred sockets be tested without a
 * socket.
 */

/** Why a stream ended. Reported to `onClose` listeners and, where possible, to the client. */
export type SseCloseReason =
  /** The client went away: navigated, refreshed, lost the network. The common case. */
  | 'client'
  /** The client stopped reading and the kernel buffer filled. See `maxBufferedBytes`. */
  | 'slow-consumer'
  /** The process is going down. */
  | 'server-shutdown'
  /** The socket errored under us. */
  | 'transport-error';

export interface SseConnection {
  readonly closed: boolean;
  /** Writes one logged event. A no-op once closed, so a fan-out never has to check. */
  send(message: StreamMessage): void;
  /**
   * Writes an event *about* the stream rather than one from it.
   *
   * Distinct from `send` precisely because it carries no `id`: a control frame
   * must not move the client's cursor, or a reconnect would resume from a
   * position the log has no event for. See `SseFrame.id`.
   */
  control(event: string, payload: unknown): void;
  /** Writes a comment line — bytes that dispatch nothing. */
  comment(text: string): void;
  /** Ends the stream. Idempotent. */
  close(reason: SseCloseReason): void;
  /** Runs exactly once, whoever closed it. */
  onClose(listener: (reason: SseCloseReason) => void): void;
}

export interface SseConnectionOptions {
  /**
   * How often a comment is written to an otherwise idle stream.
   *
   * Two different things go wrong without it, and neither announces itself. A
   * proxy — nginx's `proxy_read_timeout` is 60s, an ALB's idle timeout likewise
   * — closes a connection that has carried no bytes, and the client reconnects
   * into an endless open/timeout/reopen cycle that looks like working software.
   * Meanwhile a connection whose peer vanished without a FIN (a laptop lid, a
   * NAT rebind) stays `open` to this process indefinitely, holding its
   * subscription and its slot against `maxConnections`, because a socket nobody
   * writes to never discovers it is dead. The heartbeat is what turns the second
   * into a write that eventually fails.
   */
  readonly heartbeatIntervalMs: number;

  /** Advertised to the client once, at open. See `encodeRetry`. */
  readonly retryMs: number;

  /**
   * How many bytes may sit unacknowledged before the connection is destroyed.
   *
   * The failure this exists for is specific: `res.write()` on a socket the peer
   * has stopped reading does not block and does not fail — it buffers, in this
   * process, without limit. A single subscriber that has stopped consuming will
   * therefore accumulate every event the service publishes, forever, and the
   * incident lands as an allocation failure somewhere unrelated.
   *
   * Dropping the slow reader is the correct answer here in a way it would not be
   * for a request/response route, and the reason is `Last-Event-ID`: this
   * connection is resumable. A client dropped at the ceiling reconnects and is
   * replayed exactly what it missed, provided it was not so far behind that the
   * log evicted it — in which case it is told to re-sync, which is the honest
   * outcome for a client that could not keep up.
   *
   * Note that `write()` returning `false` is *not* this condition: false means
   * "above the high-water mark", which is the ordinary state of a socket in the
   * middle of a burst. The signal is the buffer staying above a much larger
   * bound, which is why the check reads `writableLength` after the write rather
   * than the return value.
   */
  readonly maxBufferedBytes: number;

  /** Injected so heartbeat contents are deterministic under test. */
  readonly now?: () => Date;
}

/**
 * Headers, in the order they matter.
 *
 * `Cache-Control` carries `no-transform` and not only `no-cache`: a compressing
 * intermediary is entitled to buffer a response body to compress it, and a
 * buffered event stream is one that delivers nothing until it ends — which for
 * this response is never. The same applies in-process, which is why
 * `docs/server-sent-events.md` says not to put `compression()` in front of this
 * route.
 *
 * `X-Accel-Buffering: no` is nginx-specific and harmless elsewhere. It is here
 * because nginx buffers proxied responses by default, and the resulting symptom
 * — events arrive in bursts of 4 KB, or not at all — is invariably debugged
 * against the application first.
 */
const SSE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Content-Type', 'text/event-stream; charset=utf-8'],
  ['Cache-Control', 'no-cache, no-transform'],
  ['X-Accel-Buffering', 'no'],
];

/**
 * Takes over a response and returns the handle the rest of the module uses.
 *
 * Once this returns, the response is committed: headers are flushed and the
 * status can no longer change. That is why every check that could refuse the
 * request — authentication, capacity — belongs strictly before the call. There
 * is no way to answer 503 to a stream that has already said 200.
 */
export function openSseConnection(
  req: Request,
  res: Response,
  options: SseConnectionOptions,
): SseConnection {
  const { heartbeatIntervalMs, retryMs, maxBufferedBytes, now = (): Date => new Date() } = options;

  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new RangeError(
      `openSseConnection: heartbeatIntervalMs must be an integer >= 1, received ${heartbeatIntervalMs}`,
    );
  }

  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new RangeError(
      `openSseConnection: maxBufferedBytes must be an integer >= 1, received ${maxBufferedBytes}`,
    );
  }

  const closeListeners: ((reason: SseCloseReason) => void)[] = [];
  let closed = false;

  res.statusCode = 200;
  for (const [name, value] of SSE_HEADERS) {
    res.setHeader(name, value);
  }

  // Node's default `server.requestTimeout`/socket timeout would end a
  // long-lived response that is behaving exactly as intended. Cleared on the
  // request socket rather than the server, so it applies to this stream and not
  // to every route.
  req.socket.setTimeout(0);
  // Nagle would hold a 40-byte heartbeat back for up to 40ms waiting for company
  // that is not coming. On an event stream, latency is the product.
  req.socket.setNoDelay(true);

  // Headers on the wire before the first event, so a client's `open` fires when
  // the stream opens rather than when something first happens to be published.
  res.flushHeaders();

  function runCloseListeners(reason: SseCloseReason): void {
    for (const listener of closeListeners) {
      try {
        listener(reason);
      } catch (err) {
        // A listener that throws here would abandon the listeners after it —
        // among them the hub's own unsubscribe, which is what stops a closed
        // connection from being written to forever.
        console.error('[sse] close listener failed:', err);
      }
    }
  }

  function close(reason: SseCloseReason): void {
    if (closed) return;
    closed = true;

    clearInterval(heartbeat);

    if (reason === 'slow-consumer' || reason === 'transport-error') {
      // `end()` would queue the FIN behind a backlog the peer is not draining,
      // which is the condition being escaped. `destroy()` releases the socket
      // and the buffered bytes now.
      res.destroy();
    } else {
      res.end();
    }

    runCloseListeners(reason);
  }

  function write(chunk: string): void {
    if (closed) return;

    try {
      res.write(chunk);
    } catch {
      // A write to a socket destroyed between the `closed` check and here.
      close('transport-error');
      return;
    }

    if (res.writableLength > maxBufferedBytes) {
      close('slow-consumer');
    }
  }

  function comment(text: string): void {
    write(encodeComment(text));
  }

  // Started before the listeners below rather than after, because `close`
  // clears this binding: registered first, a peer that disconnected in the same
  // tick would reach `clearInterval` while `heartbeat` was still in its
  // temporal dead zone.
  const heartbeat = setInterval(() => {
    // The timestamp is not for the client — nothing parses a comment — but for
    // whoever is reading a stream by hand with `curl` and needs to see that the
    // silence is a quiet service rather than a stalled one.
    comment(`heartbeat ${now().toISOString()}`);
  }, heartbeatIntervalMs);
  // An open socket already keeps the event loop alive; this timer should not
  // additionally keep a process running that has no connections left to serve.
  heartbeat.unref();

  // `close` on the response covers every way the peer can go away, including
  // the aborted-request case that `req`'s deprecated `aborted` event used to
  // report. It also fires for closures we initiated, which the `closed` flag
  // above absorbs.
  res.on('close', () => {
    close('client');
  });

  res.on('error', () => {
    close('transport-error');
  });

  write(encodeRetry(retryMs));

  return {
    get closed(): boolean {
      return closed;
    },

    send(message: StreamMessage): void {
      write(encodeFrame({ id: message.id, event: message.event, data: message.data }));
    },

    control(event: string, payload: unknown): void {
      write(encodeFrame({ event, data: JSON.stringify(payload) }));
    },

    comment,

    close,

    onClose(listener: (reason: SseCloseReason) => void): void {
      closeListeners.push(listener);
    },
  };
}
