import { buildObjectKey, objectKeyFromId, OBJECT_ID_PATTERN } from '@/upload/object-key';

describe('buildObjectKey', () => {
  it('keeps the extension and nothing else from the name a client sent', () => {
    const key = buildObjectKey('holiday photo.PNG');

    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\.PNG$/);
    expect(key).not.toContain('holiday');
  });

  it('handles a name with no extension', () => {
    expect(buildObjectKey('README')).toMatch(/^uploads\/[0-9a-f-]{36}$/);
  });

  it.each([
    '../../etc/passwd',
    'a.../../../../elsewhere/evil',
    'x./etc/passwd',
    'name.with spaces',
    `long.${'z'.repeat(200)}`,
    'trailing.',
  ])('never lets %p choose where its bytes land', (fileName) => {
    // The regression this pins: the extension used to be everything from the
    // last dot on, so `../../etc/passwd` produced
    // `uploads/<uuid>./etc/passwd` — client-supplied path segments in a key,
    // outside the prefix the bucket policy is written against.
    const key = buildObjectKey(fileName);

    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}(\.[A-Za-z0-9]{1,10})?$/);
    expect(OBJECT_ID_PATTERN.test(key.slice('uploads/'.length))).toBe(true);
  });

  it('keeps a legitimate extension through the same filter', () => {
    expect(buildObjectKey('a/../../b.png')).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/);
  });

  it('builds only keys it can parse back', () => {
    for (const name of ['a.png', 'a.jpeg', 'README', 'x.PDF', 'weird..png']) {
      const key = buildObjectKey(name);
      expect(objectKeyFromId(key.slice('uploads/'.length))).toBe(key);
    }
  });

  it('produces a distinct key per call', () => {
    expect(buildObjectKey('a.png')).not.toBe(buildObjectKey('a.png'));
  });
});

describe('objectKeyFromId', () => {
  it('round-trips the id half of a key it built', () => {
    const key = buildObjectKey('photo.png');
    const objectId = key.slice('uploads/'.length);

    expect(OBJECT_ID_PATTERN.test(objectId)).toBe(true);
    expect(objectKeyFromId(objectId)).toBe(key);
  });

  it.each([
    ['../../etc/passwd', 'a traversal'],
    ['uploads/00000000-0000-4000-8000-000000000000.png', 'a second prefix segment'],
    ['00000000-0000-4000-8000-000000000000/../../secret', 'a traversal after a valid id'],
    ['00000000-0000-4000-8000-000000000000%2Fx', 'a percent-encoded separator'],
    ['00000000-0000-4000-8000-00000000000', 'a short uuid'],
    ['00000000-0000-4000-8000-00000000000G', 'a non-hex character'],
    ['00000000-0000-4000-8000-000000000000.', 'a trailing dot with no extension'],
    ['00000000-0000-4000-8000-000000000000.tar.gz', 'two extensions, which this never mints'],
    ['', 'an empty id'],
  ])('refuses %p — %s', (objectId) => {
    // This is the value a *client* supplies, and it becomes part of a storage
    // key, so the whitelist is the boundary between a 422 and a path traversal.
    expect(OBJECT_ID_PATTERN.test(objectId)).toBe(false);
    expect(() => objectKeyFromId(objectId)).toThrow(RangeError);
  });
});
