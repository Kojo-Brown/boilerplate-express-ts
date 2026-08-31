import type { Request } from 'express';
import { MAX_FIELD_LENGTH } from '@/sse/frame';
import { readLastEventId } from '@/sse/last-event-id';

function requestOf(headers: Record<string, string>, query: Record<string, unknown> = {}): Request {
  return {
    get: (name: string): string | undefined => headers[name.toLowerCase()],
    query,
  } as unknown as Request;
}

describe('readLastEventId', () => {
  it('reads the header the browser maintains on its own', () => {
    // `EventSource` stores the last dispatched id and sets this on every
    // reconnect with no application code involved. It is the spec mechanism and
    // the one that covers a dropped connection.
    expect(readLastEventId(requestOf({ 'last-event-id': 'run:12' }))).toBe('run:12');
  });

  it('falls back to the query parameter, which is all a page reload has', () => {
    // A reload constructs a fresh `EventSource` with no history, and the
    // constructor takes a URL and a credentials flag — there is no way to give
    // it a header. A client that persisted its cursor has only the URL.
    expect(readLastEventId(requestOf({}, { lastEventId: 'run:12' }))).toBe('run:12');
  });

  it('prefers the header when both are present', () => {
    // The header is what the browser maintains from what it actually
    // dispatched; the query parameter is whatever the page last persisted.
    expect(
      readLastEventId(requestOf({ 'last-event-id': 'run:12' }, { lastEventId: 'run:3' })),
    ).toBe('run:12');
  });

  it('is undefined for a first connection', () => {
    expect(readLastEventId(requestOf({}))).toBeUndefined();
  });

  it.each([
    ['an empty header', { 'last-event-id': '' }],
    ['a header past the field length limit', { 'last-event-id': 'x'.repeat(MAX_FIELD_LENGTH + 1) }],
    ['a header carrying a line break', { 'last-event-id': 'a\nb' }],
    ['a header carrying U+0000', { 'last-event-id': 'a\u0000b' }],
  ])('ignores %s', (_label, headers) => {
    // Rejected here only for being unusable as a string. Whether a cursor
    // points anywhere is the log's question, and its answer is a `reset` on an
    // open stream rather than a 4xx.
    expect(readLastEventId(requestOf(headers))).toBeUndefined();
  });

  it('falls through to the query parameter when the header is unusable', () => {
    expect(readLastEventId(requestOf({ 'last-event-id': '' }, { lastEventId: 'run:4' }))).toBe(
      'run:4',
    );
  });

  it.each([
    ['a repeated parameter, which Express parses as an array', { lastEventId: ['a', 'b'] }],
    ['a bracketed parameter, which Express parses as an object', { lastEventId: { x: '1' } }],
  ])('ignores %s', (_label, query) => {
    expect(readLastEventId(requestOf({}, query))).toBeUndefined();
  });

  it('accepts a cursor exactly at the length limit', () => {
    const cursor = 'x'.repeat(MAX_FIELD_LENGTH);
    expect(readLastEventId(requestOf({ 'last-event-id': cursor }))).toBe(cursor);
  });
});
