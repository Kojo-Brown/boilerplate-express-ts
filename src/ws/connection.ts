import type { RawData } from 'ws';
import type { JwtPayload } from '@/auth/auth.types';
import { WS_CLOSE, truncateCloseReason } from '@/ws/ws.close';
import type { WsCloseCode } from '@/ws/ws.close';
import { createTokenBucket } from '@/ws/token-bucket';
import type { TokenBucket } from '@/ws/token-bucket';

/**
 * One authenticated socket, and the four ways it goes wrong if nobody is
 * watching it.
 *
 * A REST request is bounded by construction: it arrives, it is answered, the
 * memory is released, and the next one re-presents its credential. A socket is
 * the opposite on every count — it arrives once and then stays, spending this
 * process's memory and attention for as long as the peer likes — so each of
 * those four properties has to be re-established by hand:
 *
 *   1. **Rate**    a peer can write as fast as the kernel accepts. See `rateLimit`.
 *   2. **Backpressure**  a peer that stops *reading* costs us memory, not it.
 *      See `maxBufferedBytes`.
 *   3. **Liveness**  a peer that vanishes without a FIN never closes. See
 *      `heartbeatIntervalMs`.
 *   4. **Credential lifetime**  the token was checked once, at the handshake.
 *      See `expiresInMs`.
 *
 * This module holds the `WebSocket` and nothing above it does, which is what
 * lets the rules be tested against a fake socket instead of a port.
 */

/** The subset of `ws`'s `WebSocket` this module uses. Narrow so tests can supply it. */
export interface WsSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** `ws`'s `WebSocket.OPEN`, redeclared so the fake in the tests need not import `ws`. */
export const WS_OPEN = 1;

export interface WsRateLimitOptions {
  /**
   * Messages admitted in one burst.
   *
   * The burst and the rate are separate numbers on purpose. Real clients are
   * bursty — a page that reconnects and re-subscribes to nine things sends nine
   * messages in a millisecond — and a limiter with no burst allowance closes
   * exactly the connections that were behaving normally. What the burst must
   * not do is grow to the point where it is itself a viable flood, which is why
   * it is a small multiple of the rate rather than a free parameter.
   */
  readonly burst: number;

  /** Sustained inbound messages per second. */
  readonly messagesPerSecond: number;

  /**
   * Sustained inbound bytes per second.
   *
   * A second dimension because the first one does not bound work: 30 messages
   * per second of 900 KB each is inside any message-count budget and is 27 MB/s
   * of parsing. Both buckets are charged for every frame and either one can
   * refuse it.
   */
  readonly bytesPerSecond: number;

  /**
   * The largest single frame this connection will process.
   *
   * Note what this is *not*: it is not the bound on what the peer can send us,
   * because by the time a message handler runs, `ws` has already reassembled
   * the whole frame in memory. That bound is `maxPayload` on the server (see
   * `attachWebSocketServer`), which refuses oversized frames during
   * reassembly. This is the per-connection ceiling below that, and it exists so
   * the limit can differ per principal later without reconfiguring the server.
   */
  readonly maxMessageBytes: number;
}

export interface WsConnectionOptions {
  readonly principal: JwtPayload;
  readonly rateLimit: WsRateLimitOptions;

  /**
   * How often an idle socket is pinged, and how long a peer has to answer.
   *
   * The failure it exists for is the one TCP does not report: a peer that
   * disappears without a FIN — a laptop lid, a NAT rebind, a cable — leaves a
   * socket that this process still believes is open. Nothing ever closes it,
   * because a socket nobody writes to never discovers it is dead, and it holds
   * its slot against the connection ceiling forever.
   *
   * The ping is a protocol-level control frame, so a conforming client answers
   * without any application code. One missed interval is enough to terminate:
   * the ping is only sent when the socket has been quiet, and a peer that
   * answers nothing for a full interval has either gone or is so wedged that
   * dropping it and letting it reconnect is the better outcome.
   */
  readonly heartbeatIntervalMs: number;

  /**
   * Outbound bytes that may sit unacknowledged before the peer is dropped.
   *
   * `socket.send()` to a peer that has stopped reading does not block and does
   * not fail — it buffers, in this process, without limit. One subscriber that
   * stopped consuming therefore accumulates everything the service sends it,
   * and the incident lands as an allocation failure somewhere unrelated. The
   * ceiling turns that into one closed connection.
   */
  readonly maxBufferedBytes: number;

  /**
   * Milliseconds until the presented access token expires, or `undefined` for
   * one with no `exp`.
   *
   * This is the property that separates socket auth from request auth, and it
   * is the one most often missed. Every REST route re-checks the token on every
   * call, so revocation and expiry take effect within one request. A socket
   * checks it once, at the handshake — so without this a fifteen-minute token
   * authorises a connection that stays open for a week, and "short-lived access
   * tokens" stops being true of the surface that holds state.
   *
   * Closing with `TOKEN_EXPIRED` rather than dropping silently is what makes
   * the client's job possible: it refreshes and reconnects, which it cannot do
   * if it cannot tell this apart from a network fault.
   */
  readonly expiresInMs: number | undefined;

  /**
   * Handles one admitted text frame. Anything it throws closes the connection
   * with `INTERNAL_ERROR` and is logged; it is never reported to the peer,
   * because an error message built from server internals is an information
   * leak and this is the one place a client cannot be trusted with detail.
   */
  readonly onMessage: (message: string, connection: WsConnection) => void | Promise<void>;

  /** Injected so tests drive time rather than sleep. Must be monotonic. */
  readonly now?: () => number;
}

export interface WsConnection {
  readonly principal: JwtPayload;
  readonly closed: boolean;
  /** Frames refused by a bucket since the connection opened. Diagnostics. */
  readonly throttledCount: number;
  /**
   * Sends one text frame, then checks the outbound buffer.
   *
   * Returns `false` if the connection was already closed — callers fanning out
   * to many connections do not have to check first.
   */
  send(payload: unknown): boolean;
  /** Closes with a code and a reason, truncated to the 123-byte budget. Idempotent. */
  close(code: WsCloseCode, reason: string): void;
  /** Runs exactly once, whoever closed it. */
  onClose(listener: (code: number) => void): void;
}

/**
 * Wraps an open socket in the rules above.
 *
 * By the time this is called the handshake has already succeeded, so there is
 * no authentication in here — only the consequences of a credential that has a
 * shorter life than the connection it authorised.
 */
export function createWsConnection(socket: WsSocket, options: WsConnectionOptions): WsConnection {
  const {
    principal,
    rateLimit,
    heartbeatIntervalMs,
    maxBufferedBytes,
    expiresInMs,
    onMessage,
    now = (): number => performance.now(),
  } = options;

  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new RangeError(
      `createWsConnection: heartbeatIntervalMs must be an integer >= 1, received ${heartbeatIntervalMs}`,
    );
  }

  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new RangeError(
      `createWsConnection: maxBufferedBytes must be an integer >= 1, received ${maxBufferedBytes}`,
    );
  }

  const messages: TokenBucket = createTokenBucket({
    capacity: rateLimit.burst,
    refillPerSecond: rateLimit.messagesPerSecond,
    now,
  });

  // Sized so a burst of `burst` maximum-size messages is admitted, and no more.
  // Deriving it rather than exposing it separately keeps the two dimensions from
  // contradicting each other — a byte burst below one message's worth would
  // refuse every large frame permanently, which reads as a broken server.
  const bytes: TokenBucket = createTokenBucket({
    capacity: Math.max(rateLimit.bytesPerSecond, rateLimit.burst * rateLimit.maxMessageBytes),
    refillPerSecond: rateLimit.bytesPerSecond,
    now,
  });

  const closeListeners: ((code: number) => void)[] = [];
  let closed = false;
  let throttledCount = 0;
  /** Set when a ping is outstanding; cleared by the peer's pong. */
  let awaitingPong = false;

  function runCloseListeners(code: number): void {
    for (const listener of closeListeners) {
      try {
        listener(code);
      } catch (err) {
        // A listener that throws would abandon the ones after it — among them
        // the server's own deregistration, which is what stops a closed socket
        // from holding a slot against the connection ceiling forever.
        console.error('[ws] close listener failed:', err);
      }
    }
  }

  /** Every teardown path funnels through here so the timers are cleared once. */
  function finalise(code: number): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    runCloseListeners(code);
  }

  function close(code: WsCloseCode, reason: string): void {
    if (closed) return;
    // `close()` sends a close frame and waits for the peer's; a peer that has
    // stopped reading never sends one, so the reasons that mean "this peer is
    // not reading" get the socket destroyed instead of a handshake it will not
    // complete.
    if (code === WS_CLOSE.SLOW_CONSUMER || code === WS_CLOSE.UNRESPONSIVE) {
      socket.close(code, truncateCloseReason(reason));
      socket.terminate();
    } else {
      socket.close(code, truncateCloseReason(reason));
    }
    finalise(code);
  }

  function send(payload: unknown): boolean {
    if (closed || socket.readyState !== WS_OPEN) return false;

    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[ws] send failed:', err);
      finalise(WS_CLOSE.INTERNAL_ERROR);
      socket.terminate();
      return false;
    }

    // After the write, not before: `bufferedAmount` before a send says nothing
    // about the send that is about to happen, and the condition being caught is
    // a buffer that grows across many sends rather than one large one.
    if (socket.bufferedAmount > maxBufferedBytes) {
      close(
        WS_CLOSE.SLOW_CONSUMER,
        `Outbound buffer exceeded ${maxBufferedBytes} bytes; reconnect when you can keep up`,
      );
      return false;
    }

    return true;
  }

  /**
   * Charges both buckets for one frame.
   *
   * Order matters: the size ceiling is checked before either bucket, so an
   * oversized frame is refused for being oversized rather than spending a
   * message token it can never be admitted with. And the message bucket is
   * charged before the byte bucket, so a flood of tiny frames — the cheaper
   * attack to mount — is refused by the dimension that describes it.
   */
  function admit(sizeBytes: number): { admitted: true } | { admitted: false; reason: string } {
    if (sizeBytes > rateLimit.maxMessageBytes) {
      return {
        admitted: false,
        reason: `Message of ${sizeBytes} bytes exceeds the ${rateLimit.maxMessageBytes}-byte limit`,
      };
    }

    if (!messages.tryRemove(1)) {
      return {
        admitted: false,
        reason: `Message rate limit exceeded; retry in ${messages.retryAfterSeconds(1)}s`,
      };
    }

    if (!bytes.tryRemove(sizeBytes)) {
      return {
        admitted: false,
        reason: `Byte rate limit exceeded; retry in ${bytes.retryAfterSeconds(sizeBytes)}s`,
      };
    }

    return { admitted: true };
  }

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (closed) return;

    // Binary frames are refused rather than decoded. This service's protocol is
    // JSON text, and accepting binary would mean either guessing an encoding or
    // carrying a second parse path for a shape nothing sends.
    if (isBinary) {
      close(WS_CLOSE.POLICY_VIOLATION, 'Binary frames are not accepted; send UTF-8 JSON text');
      return;
    }

    // `RawData` is a Buffer, an ArrayBuffer or an array of Buffers depending on
    // how `ws` reassembled the frame. Measuring the bytes before decoding is
    // deliberate: the budget is the wire cost, and a multi-byte character
    // should be charged what it actually cost to receive.
    const raw = toBuffer(data);

    const verdict = admit(raw.byteLength);
    if (!verdict.admitted) {
      throttledCount += 1;
      close(WS_CLOSE.RATE_LIMITED, verdict.reason);
      return;
    }

    // The heartbeat only pings a *quiet* socket, so any inbound frame is proof
    // of life and clears an outstanding ping. Without this a peer that is
    // talking to us constantly but whose pong was dropped gets terminated.
    awaitingPong = false;

    void (async (): Promise<void> => {
      try {
        await onMessage(raw.toString('utf8'), connection);
      } catch (err) {
        console.error('[ws] message handler failed:', err);
        close(WS_CLOSE.INTERNAL_ERROR, 'Internal error');
      }
    })();
  });

  socket.on('pong', () => {
    awaitingPong = false;
  });

  socket.on('close', (code: number) => {
    // The peer closed, or our own `close()` completed. `finalise` is idempotent,
    // so the second case is absorbed.
    finalise(code);
  });

  socket.on('error', (err: Error) => {
    // A socket error is already terminal in `ws` — a `close` follows it — so
    // this exists to log and to keep an unhandled `error` event from becoming
    // an uncaught exception, not to tear anything down.
    console.error('[ws] socket error:', err);
  });

  const heartbeat = setInterval(() => {
    if (closed) return;

    if (awaitingPong) {
      close(WS_CLOSE.UNRESPONSIVE, `No pong within ${heartbeatIntervalMs}ms`);
      return;
    }

    awaitingPong = true;
    try {
      socket.ping();
    } catch {
      // Pinging a socket that closed between the check and here.
      finalise(WS_CLOSE.INTERNAL_ERROR);
    }
  }, heartbeatIntervalMs);
  // An open socket already holds the event loop; this timer should not keep a
  // process alive that has no connections left to serve.
  heartbeat.unref();

  // `setTimeout` takes a 32-bit signed delay and fires *immediately* — not
  // never — for anything above it. Every access token here is minutes away, but
  // clamping makes a long-lived credential a late close rather than a socket
  // that dies the instant it opens.
  const MAX_TIMEOUT_MS = 2 ** 31 - 1;

  const expiryTimer =
    expiresInMs === undefined
      ? undefined
      : setTimeout(
          () => close(WS_CLOSE.TOKEN_EXPIRED, 'Access token expired; refresh it and reconnect'),
          Math.min(expiresInMs, MAX_TIMEOUT_MS),
        ).unref();

  const connection: WsConnection = {
    principal,

    get closed(): boolean {
      return closed;
    },

    get throttledCount(): number {
      return throttledCount;
    },

    send,
    close,

    onClose(listener: (code: number) => void): void {
      closeListeners.push(listener);
    },
  };

  return connection;
}

/** Normalises `ws`'s three inbound shapes to one buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
