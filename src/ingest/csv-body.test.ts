import type { Request } from 'express';
import { AppError } from '@/lib/errors';
import { PayloadTooLargeError } from '@/streams/csv.errors';
import { requireCsvBody } from '@/ingest/csv-body';

/**
 * The two `Request` members this function touches, and nothing else — which is
 * the point of it taking a request rather than being a middleware: it is a pure
 * check over two headers and needs no server to exercise.
 */
function fakeRequest(headers: Record<string, string>): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    get: (name: string) => lower[name.toLowerCase()],
    // Models `type-is`'s three-valued contract faithfully, including the `null`
    // it returns when the request declares no body — the case a `!== false`
    // check silently accepts.
    is: (type: string) => {
      const hasBody = 'content-length' in lower || 'transfer-encoding' in lower;
      const contentType = lower['content-type'];
      if (!hasBody || contentType === undefined) return null;
      return contentType.split(';')[0]?.trim() === type ? type : false;
    },
  } as unknown as Request;
}

const MAX = 1024;

describe('requireCsvBody', () => {
  it.each(['text/csv', 'application/csv', 'text/plain'])('accepts %s', (type) => {
    const req = fakeRequest({ 'content-type': type, 'content-length': '64' });
    expect(requireCsvBody(req, MAX)).toBe(req);
  });

  it('accepts a content type carrying a charset parameter', () => {
    const req = fakeRequest({ 'content-type': 'text/csv; charset=utf-8', 'content-length': '64' });
    expect(requireCsvBody(req, MAX)).toBe(req);
  });

  it('rejects a content type it cannot read as CSV', () => {
    expect(() =>
      requireCsvBody(fakeRequest({ 'content-type': 'application/json', 'content-length': '64' }), MAX),
    ).toThrow(expect.objectContaining({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' }) as Error);
  });

  it('rejects a request with no content type at all', () => {
    expect(() => requireCsvBody(fakeRequest({ 'content-length': '64' }), MAX)).toThrow(AppError);
  });

  it('rejects a request that declares no body', () => {
    // `req.is()` answers `null` here rather than `false`, so a check written as
    // `!== false` accepts it — and an empty document parses cleanly and is
    // reported as a successful import of zero rows.
    expect(() => requireCsvBody(fakeRequest({ 'content-type': 'text/csv' }), MAX)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }) as Error,
    );
  });

  it('rejects a compressed body rather than parsing the gzip container as CSV', () => {
    // Left unchecked this becomes "your CSV has an over-long record", which is
    // true and points at entirely the wrong thing.
    expect(() =>
      requireCsvBody(
        fakeRequest({ 'content-type': 'text/csv', 'content-encoding': 'gzip', 'content-length': '64' }),
        MAX,
      ),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT_ENCODING' }) as Error);
  });

  it('treats an explicit identity encoding as no encoding', () => {
    const req = fakeRequest({
      'content-type': 'text/csv',
      'content-encoding': 'identity',
      'content-length': '64',
    });
    expect(requireCsvBody(req, MAX)).toBe(req);
  });

  it('refuses a declared length over the limit before reading a byte', () => {
    expect(() =>
      requireCsvBody(fakeRequest({ 'content-type': 'text/csv', 'content-length': '4096' }), MAX),
    ).toThrow(PayloadTooLargeError);
  });

  it('allows a declared length under the limit', () => {
    const req = fakeRequest({ 'content-type': 'text/csv', 'content-length': '512' });
    expect(requireCsvBody(req, MAX)).toBe(req);
  });

  it('does not refuse a chunked request that declares no length', () => {
    // The reason the header is a fast path and never the enforcement: the
    // limiter downstream is what actually bounds this request.
    const req = fakeRequest({ 'content-type': 'text/csv', 'transfer-encoding': 'chunked' });
    expect(requireCsvBody(req, MAX)).toBe(req);
  });

  it('ignores an unparseable content-length rather than failing on it', () => {
    const req = fakeRequest({ 'content-type': 'text/csv', 'content-length': 'not-a-number' });
    expect(requireCsvBody(req, MAX)).toBe(req);
  });
});
