import { MAX_CLOSE_REASON_BYTES, WS_CLOSE, truncateCloseReason } from '@/ws/ws.close';

describe('WS_CLOSE', () => {
  it('uses the application range for application conditions and the protocol range for protocol ones', () => {
    // The split is what a client's reconnect logic branches on, so it is worth
    // holding: anything we decided is ours to name, anything the protocol
    // defines keeps its defined code.
    for (const code of [WS_CLOSE.TOKEN_EXPIRED, WS_CLOSE.UNRESPONSIVE, WS_CLOSE.RATE_LIMITED, WS_CLOSE.SLOW_CONSUMER]) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }

    for (const code of [WS_CLOSE.NORMAL, WS_CLOSE.GOING_AWAY, WS_CLOSE.POLICY_VIOLATION, WS_CLOSE.MESSAGE_TOO_BIG, WS_CLOSE.INTERNAL_ERROR]) {
      expect(code).toBeLessThan(3000);
    }
  });

  it('assigns each condition a distinct code', () => {
    const codes = Object.values(WS_CLOSE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('truncateCloseReason', () => {
  it('leaves a reason inside the budget untouched', () => {
    const reason = 'Message rate limit exceeded; retry in 3s';
    expect(truncateCloseReason(reason)).toBe(reason);
  });

  it('leaves a reason of exactly the budget untouched', () => {
    const reason = 'a'.repeat(MAX_CLOSE_REASON_BYTES);
    expect(truncateCloseReason(reason)).toBe(reason);
    expect(Buffer.byteLength(truncateCloseReason(reason), 'utf8')).toBe(MAX_CLOSE_REASON_BYTES);
  });

  it('cuts an over-long ASCII reason to the budget', () => {
    const result = truncateCloseReason('a'.repeat(500));
    expect(Buffer.byteLength(result, 'utf8')).toBe(MAX_CLOSE_REASON_BYTES);
  });

  it('counts bytes and not characters', () => {
    // 80 four-byte characters is 320 bytes but only 160 UTF-16 code units, so a
    // `slice(123)` would return something that still overflows the frame — the
    // exact bug this function exists to prevent.
    const result = truncateCloseReason('😀'.repeat(80));
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
  });

  it('drops a character the cut landed inside rather than emitting a replacement character', () => {
    // 123 is not divisible by 4, so the cut necessarily lands mid-character.
    const result = truncateCloseReason('😀'.repeat(80));
    expect(result).not.toContain('�');
    expect(result).toBe('😀'.repeat(30));
  });

  it('preserves a replacement character that was genuinely in the input', () => {
    const reason = `�${'a'.repeat(200)}`;
    expect(truncateCloseReason(reason).startsWith('�')).toBe(true);
  });

  it('produces a reason ws will accept for every close this service sends', () => {
    // The realistic worst case: an interpolated limit and a wait, both large.
    const reasons = [
      `Message of ${Number.MAX_SAFE_INTEGER} bytes exceeds the ${Number.MAX_SAFE_INTEGER}-byte limit`,
      `Byte rate limit exceeded; retry in ${Number.MAX_SAFE_INTEGER}s`,
      `Outbound buffer exceeded ${Number.MAX_SAFE_INTEGER} bytes; reconnect when you can keep up`,
      'Access token expired; refresh it and reconnect',
    ];

    for (const reason of reasons) {
      expect(Buffer.byteLength(truncateCloseReason(reason), 'utf8')).toBeLessThanOrEqual(
        MAX_CLOSE_REASON_BYTES,
      );
    }
  });
});
