import { evaluateReadPreconditions, shouldApplyRange } from '@/http/conditional';
import type { Validators } from '@/http/conditional';

const lastModified = new Date('2026-03-04T05:06:07.000Z');
const AS_HTTP_DATE = 'Wed, 04 Mar 2026 05:06:07 GMT';

const validators: Validators = { etag: '"v1"', lastModified };

describe('evaluateReadPreconditions — If-None-Match', () => {
  it('answers not-modified when a listed tag matches', () => {
    expect(evaluateReadPreconditions({ ifNoneMatch: '"v1"' }, validators)).toBe('not-modified');
    expect(evaluateReadPreconditions({ ifNoneMatch: '"v0", "v1"' }, validators)).toBe(
      'not-modified',
    );
  });

  it('answers not-modified for the wildcard, because a representation exists', () => {
    expect(evaluateReadPreconditions({ ifNoneMatch: '*' }, validators)).toBe('not-modified');
  });

  it('uses weak comparison, so a W/-prefixed copy of the same tag still validates', () => {
    expect(evaluateReadPreconditions({ ifNoneMatch: 'W/"v1"' }, validators)).toBe('not-modified');
    expect(
      evaluateReadPreconditions({ ifNoneMatch: '"v1"' }, { etag: 'W/"v1"' }),
    ).toBe('not-modified');
  });

  it('proceeds when no listed tag matches', () => {
    expect(evaluateReadPreconditions({ ifNoneMatch: '"v0"' }, validators)).toBe('proceed');
  });

  it('proceeds on a malformed If-None-Match rather than failing the request', () => {
    expect(evaluateReadPreconditions({ ifNoneMatch: 'v1' }, validators)).toBe('proceed');
    expect(evaluateReadPreconditions({ ifNoneMatch: '"v1", *' }, validators)).toBe('proceed');
  });

  it('ignores If-Modified-Since entirely when If-None-Match is present', () => {
    // RFC 9110 §13.1.3. The combination is what a client sends to work with an
    // origin that has only one kind of validator; requiring both to pass turns
    // a touched-but-unchanged file into a full transfer on every request.
    expect(
      evaluateReadPreconditions(
        { ifNoneMatch: '"v0"', ifModifiedSince: AS_HTTP_DATE },
        validators,
      ),
    ).toBe('proceed');

    expect(
      evaluateReadPreconditions(
        { ifNoneMatch: '"v1"', ifModifiedSince: 'Thu, 01 Jan 1970 00:00:00 GMT' },
        validators,
      ),
    ).toBe('not-modified');
  });
});

describe('evaluateReadPreconditions — If-Modified-Since', () => {
  it('answers not-modified when the representation is no newer than the date', () => {
    expect(evaluateReadPreconditions({ ifModifiedSince: AS_HTTP_DATE }, validators)).toBe(
      'not-modified',
    );
  });

  it('compares at second granularity, so sub-second mtime does not defeat it', () => {
    // The failure this pins: a `lastModified` of x.750s is strictly greater
    // than the whole-second date derived from the response that carried it, so
    // a millisecond comparison never validates and the resource is re-sent
    // forever.
    const subSecond = { etag: '"v1"', lastModified: new Date(lastModified.getTime() + 750) };
    expect(evaluateReadPreconditions({ ifModifiedSince: AS_HTTP_DATE }, subSecond)).toBe(
      'not-modified',
    );
  });

  it('proceeds when the representation is newer', () => {
    const newer = { etag: '"v2"', lastModified: new Date(lastModified.getTime() + 60_000) };
    expect(evaluateReadPreconditions({ ifModifiedSince: AS_HTTP_DATE }, newer)).toBe('proceed');
  });

  it('proceeds on an unparseable date', () => {
    expect(evaluateReadPreconditions({ ifModifiedSince: 'yesterday' }, validators)).toBe(
      'proceed',
    );
  });

  it('proceeds when the representation has no Last-Modified to compare against', () => {
    expect(evaluateReadPreconditions({ ifModifiedSince: AS_HTTP_DATE }, { etag: '"v1"' })).toBe(
      'proceed',
    );
  });
});

describe('shouldApplyRange', () => {
  it('applies the range when there is no If-Range', () => {
    expect(shouldApplyRange(undefined, validators)).toBe(true);
  });

  it('applies the range when the tag strongly matches', () => {
    expect(shouldApplyRange('"v1"', validators)).toBe(true);
  });

  it('ignores the range when the tag does not match', () => {
    expect(shouldApplyRange('"v0"', validators)).toBe(false);
  });

  it('ignores the range for a weak tag on either side', () => {
    // A weak validator says "equivalent", and two equivalent representations
    // may differ byte for byte — which is exactly what splicing a range onto
    // already-downloaded bytes cannot survive.
    expect(shouldApplyRange('W/"v1"', validators)).toBe(false);
    expect(shouldApplyRange('"v1"', { etag: 'W/"v1"', lastModified })).toBe(false);
  });

  it('applies the range when an If-Range date equals Last-Modified exactly', () => {
    expect(shouldApplyRange(AS_HTTP_DATE, validators)).toBe(true);
  });

  it('ignores the range when an If-Range date is merely not older', () => {
    // Equality, not "not newer": a representation rewritten twice inside one
    // second carries an unchanged `Last-Modified`, and a `>=` comparison would
    // hand the client a range from the second one.
    const later = { etag: '"v2"', lastModified: new Date(lastModified.getTime() + 1000) };
    expect(shouldApplyRange(AS_HTTP_DATE, later)).toBe(false);
  });

  it('ignores the range when If-Range is neither a tag nor a date', () => {
    expect(shouldApplyRange('nonsense', validators)).toBe(false);
  });

  it('ignores an If-Range date when the representation has no Last-Modified', () => {
    expect(shouldApplyRange(AS_HTTP_DATE, { etag: '"v1"' })).toBe(false);
  });
});
