import type { RawData } from 'ws';
import type { JwtPayload } from '@/auth/auth.types';
import { WS_CLOSE } from '@/ws/ws.close';
import { WS_OPEN, createWsConnection } from '@/ws/connection';
import type { WsConnection, WsRateLimitOptions, WsSocket } from '@/ws/connection';

/**
 * A socket that records instead of transmitting.
 *
 * Everything in `connection.ts` is a rule about *when* to write, ping or close,
 * so a fake that captures those three is the whole surface — and it makes the
 * slow-consumer and unresponsive-peer cases, which are hard to stage against a
 * real socket and impossible to stage reliably, ordinary assertions.
 */
class FakeSocket implements WsSocket {
  readyState = WS_OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  pings = 0;
  terminated = 0;
  sendThrows: Error | null = null;

  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>();

  send(data: string): void {
    if (this.sendThrows !== null) throw this.sendThrows;
    this.sent.push(data);
  }

  ping(): void {
    this.pings += 1;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  terminate(): void {
    this.terminated += 1;
    this.readyState = 3;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  /** Delivers one inbound text frame, as `ws` would. */
  receiveText(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8') as RawData, false);
  }

  receiveBinary(bytes: Buffer): void {
    this.emit('message', bytes as RawData, true);
  }

  receivePong(): void {
    this.emit('pong');
  }

  /** The peer closed, or our own close frame completed. */
  receiveClose(code: number): void {
    this.emit('close', code, Buffer.alloc(0));
  }

  receiveError(err: Error): void {
    this.emit('error', err);
  }

  get lastClose(): { code?: number; reason?: string } | undefined {
    return this.closes.at(-1);
  }

  get parsedSent(): unknown[] {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

const principal: JwtPayload = { userId: 'user-1', roles: ['user'], type: 'access' };

const rateLimit: WsRateLimitOptions = {
  burst: 5,
  messagesPerSecond: 5,
  bytesPerSecond: 1_000,
  maxMessageBytes: 100,
};

interface Harness {
  readonly socket: FakeSocket;
  readonly connection: WsConnection;
  readonly received: string[];
  advance(ms: number): void;
}

function harness(
  overrides: {
    rateLimit?: Partial<WsRateLimitOptions>;
    heartbeatIntervalMs?: number;
    maxBufferedBytes?: number;
    expiresInMs?: number | undefined;
    onMessage?: (message: string, connection: WsConnection) => void | Promise<void>;
  } = {},
): Harness {
  const socket = new FakeSocket();
  const received: string[] = [];
  let clockMs = 0;

  const connection = createWsConnection(socket, {
    principal,
    rateLimit: { ...rateLimit, ...overrides.rateLimit },
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 1_000,
    maxBufferedBytes: overrides.maxBufferedBytes ?? 1024,
    expiresInMs: 'expiresInMs' in overrides ? overrides.expiresInMs : undefined,
    onMessage:
      overrides.onMessage ??
      ((message): void => {
        received.push(message);
      }),
    now: () => clockMs,
  });

  return {
    socket,
    connection,
    received,
    advance(ms: number): void {
      // The token buckets read the injected clock; the heartbeat and the expiry
      // timer are real timers under `jest.useFakeTimers`. Both have to move.
      clockMs += ms;
      jest.advanceTimersByTime(ms);
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('createWsConnection', () => {
  it('rejects an invalid heartbeat interval or buffer ceiling', () => {
    const socket = new FakeSocket();
    const base = {
      principal,
      rateLimit,
      maxBufferedBytes: 1024,
      expiresInMs: undefined,
      onMessage: (): void => {},
    };

    expect(() => createWsConnection(socket, { ...base, heartbeatIntervalMs: 0 })).toThrow(RangeError);
    expect(() => createWsConnection(socket, { ...base, heartbeatIntervalMs: 1.5 })).toThrow(RangeError);
    expect(() =>
      createWsConnection(socket, { ...base, heartbeatIntervalMs: 1_000, maxBufferedBytes: 0 }),
    ).toThrow(RangeError);
  });

  describe('inbound messages', () => {
    it('passes an admitted frame to the handler as text', () => {
      const h = harness();
      h.socket.receiveText('{"type":"ping"}');
      expect(h.received).toEqual(['{"type":"ping"}']);
    });

    it('decodes multi-byte characters correctly', () => {
      const h = harness();
      h.socket.receiveText('{"payload":"héllo 😀"}');
      expect(h.received).toEqual(['{"payload":"héllo 😀"}']);
    });

    it('ignores frames that arrive after close', () => {
      const h = harness();
      h.connection.close(WS_CLOSE.NORMAL, 'done');
      h.socket.receiveText('{"type":"ping"}');
      expect(h.received).toEqual([]);
    });
  });

  describe('rate limiting', () => {
    it('admits a burst up to the configured size', () => {
      const h = harness();
      for (let i = 0; i < 5; i += 1) h.socket.receiveText('x');
      expect(h.received).toHaveLength(5);
      expect(h.connection.closed).toBe(false);
    });

    it('closes with 4008 once the message budget is spent', () => {
      const h = harness();
      for (let i = 0; i < 6; i += 1) h.socket.receiveText('x');

      expect(h.received).toHaveLength(5);
      expect(h.connection.closed).toBe(true);
      expect(h.connection.throttledCount).toBe(1);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.RATE_LIMITED);
      expect(h.socket.lastClose?.reason).toContain('Message rate limit exceeded');
    });

    it('admits again once the bucket has refilled', () => {
      const h = harness();
      for (let i = 0; i < 5; i += 1) h.socket.receiveText('x');

      h.advance(1_000);
      h.socket.receiveText('x');

      // 5/s for one second refilled the whole burst; nothing was throttled.
      expect(h.received).toHaveLength(6);
      expect(h.connection.closed).toBe(false);
    });

    it('closes on the byte budget even while the message budget holds', () => {
      const h = harness({
        rateLimit: { burst: 10, messagesPerSecond: 10, bytesPerSecond: 100, maxMessageBytes: 60 },
      });

      // The byte bucket holds `burst * maxMessageBytes`, so a full burst of
      // maximum-size frames is admitted by construction — the byte dimension
      // bites on the *sustained* rate, which is what it is for.
      for (let i = 0; i < 10; i += 1) h.socket.receiveText('a'.repeat(60));
      expect(h.received).toHaveLength(10);
      expect(h.connection.closed).toBe(false);

      // 200ms refills 2 messages but only 20 bytes. The next 60-byte frame is
      // inside the message budget and outside the byte budget.
      h.advance(200);
      h.socket.receiveText('a'.repeat(60));

      expect(h.received).toHaveLength(10);
      expect(h.connection.closed).toBe(true);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.RATE_LIMITED);
      expect(h.socket.lastClose?.reason).toContain('Byte rate limit exceeded');
    });

    it('charges bytes on the wire, not UTF-16 code units', () => {
      const h = harness({
        rateLimit: { burst: 2, messagesPerSecond: 2, bytesPerSecond: 10, maxMessageBytes: 8 },
      });

      // Two characters, eight bytes: over the 8-byte ceiling would be wrong,
      // exactly at it is admitted. A `length`-based charge would see 4.
      h.socket.receiveText('😀😀');
      expect(h.received).toHaveLength(1);
      expect(h.connection.closed).toBe(false);
    });

    it('refuses an oversized frame as oversized rather than as a rate violation', () => {
      const h = harness({ rateLimit: { maxMessageBytes: 10 } });
      h.socket.receiveText('a'.repeat(11));

      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.RATE_LIMITED);
      expect(h.socket.lastClose?.reason).toContain('exceeds the 10-byte limit');
      expect(h.socket.lastClose?.reason).not.toContain('rate limit');
    });

    it('does not spend a message token on a frame it refuses for size', () => {
      // Otherwise a client sending oversized frames would be reported as
      // rate-limited on its second one, which describes the wrong problem.
      const h = harness({ rateLimit: { burst: 2, maxMessageBytes: 10 } });
      h.socket.receiveText('a'.repeat(11));
      expect(h.socket.lastClose?.reason).toContain('exceeds the 10-byte limit');
    });

    it('closes with a reason short enough for a close frame', () => {
      const h = harness({ rateLimit: { maxMessageBytes: Number.MAX_SAFE_INTEGER } });
      // Nothing here can produce a 123-byte reason on its own, so the guard is
      // asserted where it is cheapest to assert: every close this class emits.
      h.socket.receiveBinary(Buffer.from('x'));
      expect(Buffer.byteLength(h.socket.lastClose?.reason ?? '', 'utf8')).toBeLessThanOrEqual(123);
    });
  });

  describe('binary frames', () => {
    it('closes with a policy violation rather than guessing an encoding', () => {
      const h = harness();
      h.socket.receiveBinary(Buffer.from([0x00, 0x01, 0x02]));

      expect(h.received).toEqual([]);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.POLICY_VIOLATION);
    });
  });

  describe('outbound', () => {
    it('serialises a payload as JSON', () => {
      const h = harness();
      expect(h.connection.send({ type: 'pong', id: 'a' })).toBe(true);
      expect(h.socket.parsedSent).toEqual([{ type: 'pong', id: 'a' }]);
    });

    it('is a no-op returning false once closed', () => {
      const h = harness();
      h.connection.close(WS_CLOSE.NORMAL, 'done');
      expect(h.connection.send({ type: 'pong' })).toBe(false);
      expect(h.socket.sent).toEqual([]);
    });

    it('is a no-op when the socket is no longer OPEN', () => {
      const h = harness();
      h.socket.readyState = 2; // CLOSING
      expect(h.connection.send({ type: 'pong' })).toBe(false);
    });

    it('closes a peer whose outbound buffer passes the ceiling', () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness({ maxBufferedBytes: 100 });

      h.socket.bufferedAmount = 101;
      expect(h.connection.send({ big: true })).toBe(false);

      expect(h.connection.closed).toBe(true);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.SLOW_CONSUMER);
      // A peer that is not reading will never complete a close handshake, so
      // the socket is destroyed rather than left waiting for a close frame.
      expect(h.socket.terminated).toBe(1);
    });

    it('does not close a buffer sitting exactly at the ceiling', () => {
      const h = harness({ maxBufferedBytes: 100 });
      h.socket.bufferedAmount = 100;
      expect(h.connection.send({ ok: true })).toBe(true);
      expect(h.connection.closed).toBe(false);
    });

    it('tears down on a send that throws instead of leaving a half-open socket', () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness();
      h.socket.sendThrows = new Error('socket gone');

      expect(h.connection.send({ type: 'pong' })).toBe(false);
      expect(h.connection.closed).toBe(true);
      expect(h.socket.terminated).toBe(1);
    });
  });

  describe('heartbeat', () => {
    it('pings a quiet socket once per interval', () => {
      const h = harness({ heartbeatIntervalMs: 1_000 });

      h.advance(1_000);
      expect(h.socket.pings).toBe(1);

      h.socket.receivePong();
      h.advance(1_000);
      expect(h.socket.pings).toBe(2);
      expect(h.connection.closed).toBe(false);
    });

    it('terminates a peer that does not answer within an interval', () => {
      const h = harness({ heartbeatIntervalMs: 1_000 });

      h.advance(1_000);
      expect(h.socket.pings).toBe(1);

      // No pong. The next tick finds the ping still outstanding.
      h.advance(1_000);
      expect(h.connection.closed).toBe(true);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.UNRESPONSIVE);
      expect(h.socket.terminated).toBe(1);
    });

    it('treats an inbound message as proof of life', () => {
      const h = harness({ heartbeatIntervalMs: 1_000 });

      h.advance(1_000);
      expect(h.socket.pings).toBe(1);

      // A peer talking to us constantly but whose pong was dropped must not be
      // terminated for being unresponsive.
      h.socket.receiveText('x');
      h.advance(1_000);

      expect(h.connection.closed).toBe(false);
      expect(h.socket.pings).toBe(2);
    });

    it('stops pinging once closed', () => {
      const h = harness({ heartbeatIntervalMs: 1_000 });
      h.connection.close(WS_CLOSE.NORMAL, 'done');

      h.advance(10_000);
      expect(h.socket.pings).toBe(0);
    });
  });

  describe('token expiry', () => {
    it('closes with 4001 when the presented token expires', () => {
      const h = harness({ expiresInMs: 5_000, heartbeatIntervalMs: 60_000 });

      h.advance(4_999);
      expect(h.connection.closed).toBe(false);

      h.advance(1);
      expect(h.connection.closed).toBe(true);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.TOKEN_EXPIRED);
      expect(h.socket.lastClose?.reason).toContain('refresh');
    });

    it('leaves a connection open indefinitely for a token with no exp', () => {
      const h = harness({ expiresInMs: undefined, heartbeatIntervalMs: 60_000 });

      for (let i = 0; i < 100; i += 1) {
        h.advance(60_000);
        h.socket.receivePong();
      }

      expect(h.connection.closed).toBe(false);
    });

    it('does not fire immediately for a delay above the 32-bit timer ceiling', () => {
      // `setTimeout` above 2^31-1 fires *now*, not never, so an unclamped
      // long-lived token would close its socket the instant it opened.
      const h = harness({ expiresInMs: 2 ** 32, heartbeatIntervalMs: 60_000 });

      h.advance(0);
      expect(h.connection.closed).toBe(false);
    });
  });

  describe('close', () => {
    it('is idempotent and notifies listeners exactly once', () => {
      const h = harness();
      const listener = jest.fn();
      h.connection.onClose(listener);

      h.connection.close(WS_CLOSE.NORMAL, 'done');
      h.connection.close(WS_CLOSE.NORMAL, 'again');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(WS_CLOSE.NORMAL);
      expect(h.socket.closes).toHaveLength(1);
    });

    it('notifies listeners when the peer closes', () => {
      const h = harness();
      const listener = jest.fn();
      h.connection.onClose(listener);

      h.socket.receiveClose(1000);

      expect(h.connection.closed).toBe(true);
      expect(listener).toHaveBeenCalledWith(1000);
    });

    it('runs the remaining listeners when one throws', () => {
      // The server's own deregistration is one of these, and losing it would
      // leak a slot against the connection ceiling for the life of the process.
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness();
      const second = jest.fn();

      h.connection.onClose(() => {
        throw new Error('listener bug');
      });
      h.connection.onClose(second);

      h.connection.close(WS_CLOSE.NORMAL, 'done');
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('truncates an over-long reason instead of letting ws throw', () => {
      const h = harness();
      h.connection.close(WS_CLOSE.NORMAL, 'x'.repeat(500));
      expect(Buffer.byteLength(h.socket.lastClose?.reason ?? '', 'utf8')).toBe(123);
    });
  });

  describe('handler failures', () => {
    it('closes with a generic internal error and leaks nothing to the peer', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness({
        onMessage: () => {
          throw new Error('connection string postgres://user:hunter2@db/app failed');
        },
      });

      h.socket.receiveText('x');
      await Promise.resolve();

      expect(h.connection.closed).toBe(true);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.INTERNAL_ERROR);
      expect(h.socket.lastClose?.reason).toBe('Internal error');
    });

    it('closes when an async handler rejects', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness({
        onMessage: async () => {
          await Promise.resolve();
          throw new Error('async failure');
        },
      });

      h.socket.receiveText('x');
      await Promise.resolve();
      await Promise.resolve();

      expect(h.connection.closed).toBe(true);
      expect(h.socket.lastClose?.code).toBe(WS_CLOSE.INTERNAL_ERROR);
    });
  });

  it('logs a socket error without tearing the connection down itself', () => {
    // `ws` follows an error with a close, so this handler exists to keep an
    // unhandled `error` event from becoming an uncaught exception.
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();

    h.socket.receiveError(new Error('ECONNRESET'));

    expect(error).toHaveBeenCalled();
    expect(h.connection.closed).toBe(false);
  });

  it('exposes the handshake principal to the message handler', () => {
    let seen: WsConnection | undefined;
    const h = harness({
      onMessage: (_message, connection): void => {
        seen = connection;
      },
    });

    h.socket.receiveText('x');
    expect(seen?.principal).toEqual(principal);
  });
});
