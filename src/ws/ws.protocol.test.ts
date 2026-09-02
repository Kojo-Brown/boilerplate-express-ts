import type { JwtPayload } from '@/auth/auth.types';
import type { WsConnection } from '@/ws/connection';
import type { WsCloseCode } from '@/ws/ws.close';
import { handleClientFrame } from '@/ws/ws.protocol';
import type { ServerFrame } from '@/ws/ws.protocol';

/** Only `send`, `close` and `principal` are read, so only those are provided. */
function fakeConnection(principal?: Partial<JwtPayload>): {
  connection: WsConnection;
  sent: ServerFrame[];
  closes: { code: WsCloseCode; reason: string }[];
} {
  const sent: ServerFrame[] = [];
  const closes: { code: WsCloseCode; reason: string }[] = [];

  const connection: WsConnection = {
    principal: { userId: 'user-1', roles: ['user'], type: 'access', ...principal },
    closed: false,
    throttledCount: 0,
    send(payload: unknown): boolean {
      sent.push(payload as ServerFrame);
      return true;
    },
    close(code: WsCloseCode, reason: string): void {
      closes.push({ code, reason });
    },
    onClose(): void {},
  };

  return { connection, sent, closes };
}

describe('handleClientFrame', () => {
  it('answers a ping with a pong', () => {
    const { connection, sent } = fakeConnection();
    handleClientFrame('{"type":"ping"}', connection);
    expect(sent).toEqual([{ type: 'pong' }]);
  });

  it('echoes the correlation id so a client can match a reply to its request', () => {
    const { connection, sent } = fakeConnection();
    handleClientFrame('{"type":"ping","id":"req-7"}', connection);
    expect(sent).toEqual([{ type: 'pong', id: 'req-7' }]);
  });

  it('omits the id entirely when the client sent none', () => {
    // Rather than `id: undefined`, which serialises to a key the client has to
    // ignore and which `exactOptionalPropertyTypes` would reject.
    const { connection, sent } = fakeConnection();
    handleClientFrame('{"type":"ping"}', connection);
    expect(Object.keys(sent[0] ?? {})).toEqual(['type']);
  });

  it('returns an echo payload unchanged, whatever its shape', () => {
    const { connection, sent } = fakeConnection();
    const payload = { nested: { list: [1, 'two', null, true] } };
    handleClientFrame(JSON.stringify({ type: 'echo', id: 'e1', payload }), connection);
    expect(sent).toEqual([{ type: 'echo', id: 'e1', payload }]);
  });

  it('echoes a null payload rather than treating it as absent', () => {
    const { connection, sent } = fakeConnection();
    handleClientFrame('{"type":"echo","payload":null}', connection);
    expect(sent).toEqual([{ type: 'echo', payload: null }]);
  });

  it('reports the handshake principal for whoami', () => {
    const { connection, sent } = fakeConnection({ userId: 'user-42', roles: ['admin', 'user'] });
    handleClientFrame('{"type":"whoami","id":"w1"}', connection);
    expect(sent).toEqual([{ type: 'whoami', id: 'w1', userId: 'user-42', roles: ['admin', 'user'] }]);
  });

  describe('bad input', () => {
    it('answers malformed JSON with an error frame and does not close', () => {
      // Closing over one bad frame throws away every subscription on the socket
      // and sends the client into a reconnect loop it cannot debug.
      const { connection, sent, closes } = fakeConnection();
      handleClientFrame('{not json', connection);

      expect(sent).toEqual([{ type: 'error', code: 'MALFORMED_FRAME', message: 'Frame is not valid JSON' }]);
      expect(closes).toEqual([]);
    });

    it('answers an unknown message type with an error frame', () => {
      const { connection, sent, closes } = fakeConnection();
      handleClientFrame('{"type":"launch-missiles"}', connection);

      expect(sent[0]).toMatchObject({ type: 'error', code: 'INVALID_FRAME' });
      expect(closes).toEqual([]);
    });

    it('correlates the error to the frame that failed validation', () => {
      const { connection, sent } = fakeConnection();
      handleClientFrame('{"type":"nope","id":"req-9"}', connection);
      expect(sent[0]).toMatchObject({ id: 'req-9' });
    });

    it('ignores a non-string id on a rejected frame', () => {
      const { connection, sent } = fakeConnection();
      handleClientFrame('{"type":"nope","id":{"evil":true}}', connection);
      expect(sent[0]).not.toHaveProperty('id');
    });

    it('ignores an over-long id on a rejected frame', () => {
      const { connection, sent } = fakeConnection();
      handleClientFrame(JSON.stringify({ type: 'nope', id: 'a'.repeat(65) }), connection);
      expect(sent[0]).not.toHaveProperty('id');
    });

    it('rejects an over-long id on a well-formed frame', () => {
      const { connection, sent } = fakeConnection();
      handleClientFrame(JSON.stringify({ type: 'ping', id: 'a'.repeat(65) }), connection);
      expect(sent[0]).toMatchObject({ type: 'error', code: 'INVALID_FRAME' });
    });

    it('rejects a JSON value that is not an object', () => {
      const { connection, sent } = fakeConnection();
      for (const frame of ['42', '"ping"', 'null', '[]']) {
        handleClientFrame(frame, connection);
      }
      expect(sent).toHaveLength(4);
      for (const reply of sent) {
        expect(reply).toMatchObject({ type: 'error', code: 'INVALID_FRAME' });
      }
    });

    it('always answers exactly once, whatever it was sent', () => {
      const { connection, sent } = fakeConnection();
      const frames = ['{"type":"ping"}', '{"type":"echo","payload":1}', '{"type":"whoami"}', 'garbage', '{}'];

      for (const frame of frames) handleClientFrame(frame, connection);

      // "I sent something and heard nothing" should be a bug report, never an
      // ambiguity in the protocol.
      expect(sent).toHaveLength(frames.length);
    });
  });
});
