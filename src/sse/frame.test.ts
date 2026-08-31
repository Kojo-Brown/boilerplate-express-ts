import { encodeComment, encodeFrame, encodeRetry, MAX_FIELD_LENGTH } from '@/sse/frame';

const NUL = '\u0000';

describe('encodeFrame', () => {
  it('encodes the minimal frame: data and the blank line that dispatches it', () => {
    expect(encodeFrame({ data: 'hello' })).toBe('data: hello\n\n');
  });

  it('puts the id first, then the event type', () => {
    expect(encodeFrame({ id: 'a:1', event: 'user.created', data: '{}' })).toBe(
      'id: a:1\nevent: user.created\ndata: {}\n\n',
    );
  });

  it('keeps a colon inside an id, which is how the log addresses its own events', () => {
    // `id: <value>` takes everything after the first colon-space, so the
    // separator in `<streamId>:<sequence>` needs no escaping.
    expect(encodeFrame({ id: 'deadbeef:42', data: 'x' })).toBe('id: deadbeef:42\ndata: x\n\n');
  });

  it('splits multi-line data across one `data:` line each', () => {
    // Not decoration: a single `data:` line carrying a newline would be two
    // lines to the client, the second of which is not a field it knows.
    expect(encodeFrame({ data: 'one\ntwo' })).toBe('data: one\ndata: two\n\n');
  });

  it.each([
    ['CRLF', 'one\r\ntwo'],
    ['a bare CR', 'one\rtwo'],
  ])('normalises %s in data to the LF the client will rejoin with', (_label, data) => {
    // The client's line splitter treats all three terminators identically and
    // rejoins data lines with LF, so this makes the encoded string equal to the
    // string the client observes rather than leaving a CR that does not survive.
    expect(encodeFrame({ data })).toBe('data: one\ndata: two\n\n');
  });

  it('encodes empty data as a field rather than dropping it', () => {
    expect(encodeFrame({ id: 'a:1', data: '' })).toBe('id: a:1\ndata: \n\n');
  });

  it('does not treat a trailing newline in data as the end of the frame', () => {
    expect(encodeFrame({ data: 'x\n' })).toBe('data: x\ndata: \n\n');
  });

  it.each([
    ['id', 'a\nb'],
    ['id', 'a\rb'],
    ['id', 'a\r\nb'],
    ['event', 'a\nb'],
  ])('rejects a line break in %s (%j)', (field, value) => {
    // The injection this exists for: `id: 1\nevent: admin.granted\ndata: …`
    // is not a corrupt field, it is three valid fields, and the client
    // dispatches the event the server never meant to send.
    expect(() => encodeFrame({ ...{ [field]: value }, data: 'x' })).toThrow(RangeError);
  });

  it.each([
    ['id', `a${NUL}b`],
    ['event', `a${NUL}b`],
  ])('rejects U+0000 in %s', (field, value) => {
    // Worse than a hard failure: a client *ignores* an id containing NUL, so
    // the frame is delivered, the cursor silently does not advance, and the
    // next reconnect replays from a position the client has already passed.
    expect(() => encodeFrame({ ...{ [field]: value }, data: 'x' })).toThrow(/U\+0000/);
  });

  it('rejects an empty event, which would dispatch as `message` at the cost of a line', () => {
    expect(() => encodeFrame({ event: '', data: 'x' })).toThrow(RangeError);
  });

  it('accepts a field at the length limit and rejects one past it', () => {
    expect(() => encodeFrame({ id: 'x'.repeat(MAX_FIELD_LENGTH), data: 'y' })).not.toThrow();
    expect(() => encodeFrame({ id: 'x'.repeat(MAX_FIELD_LENGTH + 1), data: 'y' })).toThrow(
      RangeError,
    );
  });

  it('leaves the newline-free data of a JSON payload alone', () => {
    // Why everything published through the hub is JSON: the escapes make the
    // payload a single line whatever it contains.
    const data = JSON.stringify({ note: 'line one\nline two\r' });
    expect(encodeFrame({ data })).toBe(`data: ${data}\n\n`);
    expect(encodeFrame({ data }).split('\n').filter((l) => l.startsWith('data:'))).toHaveLength(1);
  });
});

describe('encodeComment', () => {
  it('writes a line the client parses and discards', () => {
    expect(encodeComment('heartbeat')).toBe(': heartbeat\n\n');
  });

  it('rejects a line break, which would let the remainder be parsed as fields', () => {
    expect(() => encodeComment('a\nevent: forged')).toThrow(RangeError);
  });
});

describe('encodeRetry', () => {
  it('advertises the reconnection delay', () => {
    expect(encodeRetry(3000)).toBe('retry: 3000\n\n');
  });

  it('accepts zero — reconnect immediately', () => {
    expect(encodeRetry(0)).toBe('retry: 0\n\n');
  });

  it.each([
    [1.5, 'a fraction'],
    [-1, 'a negative delay'],
    [Number.NaN, 'NaN'],
  ])('rejects %p (%s), which the client would silently ignore', (delay) => {
    // §9.2.6 requires ASCII digits and ignores the field otherwise, so
    // `retry: 1.5` is not an error at the client — it is no retry field at all.
    expect(() => encodeRetry(delay)).toThrow(RangeError);
  });
});
