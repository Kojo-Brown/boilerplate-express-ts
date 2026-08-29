import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '@/lib/errors';
import { createMemoryStorageProvider } from '@/upload/storage/memory.provider';
import type { MemoryStorageProvider } from '@/upload/storage/memory.provider';

/**
 * Runs `fn` and hands back whatever it threw, so a single call can be asserted
 * on. `expect(fn).toThrow(...)` would invoke it twice, and every throwing path
 * here mutates the reservation table on its way out.
 */
function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it returned');
}

function expectAppErrorCode(thrown: unknown, code: string): void {
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(code);
}

/** Frozen clock the tests advance by hand — nothing here waits on real time. */
function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

let clock: ReturnType<typeof makeClock>;
let storage: MemoryStorageProvider;

beforeEach(() => {
  clock = makeClock();
  storage = createMemoryStorageProvider({ now: clock.now, expiresIn: 60 });
});

describe('put', () => {
  it('stores the bytes under a server-generated key and returns its URL', async () => {
    const result = await storage.put(Buffer.from('png-bytes'), 'photo.png', 'image/png');

    expect(result.key).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/);
    expect(result.url).toBe(`memory://${result.key}`);
    expect(storage.get(result.key)?.bytes.toString()).toBe('png-bytes');
    expect(storage.get(result.key)?.contentType).toBe('image/png');
  });

  it('ignores the client-supplied path and keeps only the extension', async () => {
    const result = await storage.put(Buffer.from('x'), '../../etc/passwd.pdf', 'application/pdf');

    expect(result.key.startsWith('uploads/')).toBe(true);
    expect(result.key).not.toContain('..');
    expect(result.key.endsWith('.pdf')).toBe(true);
  });

  it('gives two uploads of the same filename distinct keys', async () => {
    const first = await storage.put(Buffer.from('a'), 'photo.png', 'image/png');
    const second = await storage.put(Buffer.from('b'), 'photo.png', 'image/png');

    expect(first.key).not.toBe(second.key);
    expect(storage.size).toBe(2);
  });

  it('copies the buffer so a reused Multer allocation cannot mutate it', async () => {
    const buffer = Buffer.from('original');
    const result = await storage.put(buffer, 'a.pdf', 'application/pdf');

    buffer.write('OVERWRIT');

    expect(storage.get(result.key)?.bytes.toString()).toBe('original');
  });
});

describe('presignPut', () => {
  it('returns a URL for a reserved key and the configured lifetime', async () => {
    const presigned = await storage.presignPut('photo.jpg', 'image/jpeg');

    expect(presigned.key).toMatch(/^uploads\/[0-9a-f-]{36}\.jpg$/);
    expect(presigned.presignedUrl).toBe(`memory://${presigned.key}`);
    expect(presigned.expiresIn).toBe(60);
  });

  it('does not store anything until the upload is completed', async () => {
    await storage.presignPut('photo.jpg', 'image/jpeg');

    expect(storage.size).toBe(0);
  });
});

describe('completePresigned', () => {
  it('stores the bytes under the reserved key', async () => {
    const presigned = await storage.presignPut('photo.jpg', 'image/jpeg');

    const stored = storage.completePresigned(
      presigned.presignedUrl,
      Buffer.from('jpeg-bytes'),
      'image/jpeg',
    );

    expect(stored.key).toBe(presigned.key);
    expect(storage.get(presigned.key)?.bytes.toString()).toBe('jpeg-bytes');
  });

  it('honours a reservation right up to its expiry', async () => {
    const presigned = await storage.presignPut('photo.jpg', 'image/jpeg');

    clock.advance(59_999);

    expect(() =>
      storage.completePresigned(presigned.presignedUrl, Buffer.from('x'), 'image/jpeg'),
    ).not.toThrow();
  });

  it('rejects a reservation the moment it expires', async () => {
    const presigned = await storage.presignPut('photo.jpg', 'image/jpeg');

    clock.advance(60_000);

    const thrown = catchThrown(() =>
      storage.completePresigned(presigned.presignedUrl, Buffer.from('x'), 'image/jpeg'),
    );

    expectAppErrorCode(thrown, 'PRESIGNED_URL_EXPIRED');
    expect(storage.size).toBe(0);
  });

  it('rejects a replay of an already-used URL without overwriting the object', async () => {
    const presigned = await storage.presignPut('photo.jpg', 'image/jpeg');
    storage.completePresigned(presigned.presignedUrl, Buffer.from('first'), 'image/jpeg');

    const thrown = catchThrown(() =>
      storage.completePresigned(presigned.presignedUrl, Buffer.from('second'), 'image/jpeg'),
    );

    expectAppErrorCode(thrown, 'PRESIGNED_URL_UNKNOWN');
    expect(storage.get(presigned.key)?.bytes.toString()).toBe('first');
  });

  it('rejects a key that was never reserved', () => {
    const thrown = catchThrown(() =>
      storage.completePresigned('memory://uploads/not-reserved.png', Buffer.from('x'), 'image/png'),
    );

    expectAppErrorCode(thrown, 'PRESIGNED_URL_UNKNOWN');
  });

  it('rejects a URL belonging to another driver', () => {
    const thrown = catchThrown(() =>
      storage.completePresigned(
        'https://bucket.s3.amazonaws.com/uploads/x.png',
        Buffer.from('x'),
        'image/png',
      ),
    );

    expectAppErrorCode(thrown, 'INVALID_PRESIGNED_URL');
  });
});

describe('publicUrl and clear', () => {
  it('builds the same URL put returns', async () => {
    const result = await storage.put(Buffer.from('x'), 'a.png', 'image/png');

    expect(storage.publicUrl(result.key)).toBe(result.url);
  });

  it('drops stored objects and outstanding reservations', async () => {
    const presigned = await storage.presignPut('photo.jpg', 'image/jpeg');
    await storage.put(Buffer.from('x'), 'a.png', 'image/png');

    storage.clear();

    expect(storage.size).toBe(0);
    expectAppErrorCode(
      catchThrown(() =>
        storage.completePresigned(presigned.presignedUrl, Buffer.from('x'), 'image/jpeg'),
      ),
      'PRESIGNED_URL_UNKNOWN',
    );
  });
});

describe('stat', () => {
  it('reports the size, type, digest and write time of a stored object', async () => {
    const bytes = Buffer.from('png-bytes');
    const { key } = await storage.put(bytes, 'photo.png', 'image/png');

    const stat = await storage.stat(key);

    expect(stat).toEqual({
      key,
      size: bytes.length,
      contentType: 'image/png',
      etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
      lastModified: new Date(clock.now()),
    });
  });

  it('reports nothing rather than throwing for a key that was never written', async () => {
    // "Not there" is what a client asking for a deleted key looks like, which
    // the route turns into a 404 — not an exceptional condition.
    await expect(storage.stat('uploads/never-written.png')).resolves.toBeUndefined();
  });

  it('gives two objects with identical bytes the same tag, and different bytes different tags', async () => {
    const a = await storage.put(Buffer.from('same'), 'a.png', 'image/png');
    const b = await storage.put(Buffer.from('same'), 'b.png', 'image/png');
    const c = await storage.put(Buffer.from('other'), 'c.png', 'image/png');

    const [statA, statB, statC] = await Promise.all([
      storage.stat(a.key),
      storage.stat(b.key),
      storage.stat(c.key),
    ]);

    expect(statA?.etag).toBe(statB?.etag);
    expect(statA?.etag).not.toBe(statC?.etag);
  });
});

describe('openRange', () => {
  /** Everything a stream yielded, and how it was chunked getting there. */
  async function drain(stream: Readable): Promise<{ body: Buffer; chunks: number[] }> {
    const parts: Buffer[] = [];
    for await (const chunk of stream) {
      parts.push(chunk as Buffer);
    }
    return { body: Buffer.concat(parts), chunks: parts.map((p) => p.length) };
  }

  async function storeLarge(sizeBytes: number): Promise<{ key: string; etag: string }> {
    // A deterministic filler rather than random bytes: a failing assertion
    // should name an offset, not a seed.
    const bytes = Buffer.alloc(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) bytes[i] = i % 251;

    const { key } = await storage.put(bytes, 'big.pdf', 'application/pdf');
    const stat = await storage.stat(key);
    if (stat === undefined) throw new Error('the object just written is not there');
    return { key, etag: stat.etag };
  }

  it('yields exactly the requested interval', async () => {
    const bytes = Buffer.from('0123456789');
    const { key } = await storage.put(bytes, 'a.png', 'image/png');
    const stat = await storage.stat(key);
    if (stat === undefined) throw new Error('the object just written is not there');

    const { body } = await drain(await storage.openRange(key, { start: 2, end: 5 }, stat.etag));

    expect(body.toString()).toBe('2345');
  });

  it('hands the object out in chunks rather than as one buffer', async () => {
    // Not a style preference: in a single chunk there is no second `read()`,
    // so nothing downstream can ever exert backpressure and a caller cannot
    // tell this from an implementation that buffers the whole object.
    const { key, etag } = await storeLarge(200 * 1024);

    const { body, chunks } = await drain(
      await storage.openRange(key, { start: 0, end: 200 * 1024 - 1 }, etag),
    );

    expect(body.length).toBe(200 * 1024);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(64 * 1024);
  });

  it('reads a range that spans a chunk boundary correctly', async () => {
    const size = 200 * 1024;
    const { key, etag } = await storeLarge(size);
    const start = 64 * 1024 - 3;
    const end = 64 * 1024 + 2;

    const { body } = await drain(await storage.openRange(key, { start, end }, etag));

    expect(body.length).toBe(end - start + 1);
    expect([...body]).toEqual(
      Array.from({ length: end - start + 1 }, (_, i) => (start + i) % 251),
    );
  });

  it('refuses a key that is no longer there', async () => {
    const { key } = await storage.put(Buffer.from('first'), 'a.png', 'image/png');
    const stat = await storage.stat(key);
    if (stat === undefined) throw new Error('the object just written is not there');

    storage.clear();

    expectAppErrorCode(
      catchThrown(() => storage.openRange(key, { start: 0, end: 4 }, stat.etag)),
      'OBJECT_NOT_FOUND',
    );
  });

  it('rejects a stale tag on an object that is still there', async () => {
    const { key } = await storage.put(Buffer.from('first'), 'a.png', 'image/png');

    expectAppErrorCode(
      catchThrown(() => storage.openRange(key, { start: 0, end: 0 }, '"not-the-tag"')),
      'REPRESENTATION_CHANGED',
    );
  });

  it('rejects an interval the object does not contain', async () => {
    const { key } = await storage.put(Buffer.from('0123456789'), 'a.png', 'image/png');
    const stat = await storage.stat(key);
    if (stat === undefined) throw new Error('the object just written is not there');
    const etag = stat.etag;

    expect(() => storage.openRange(key, { start: 0, end: 10 }, etag)).toThrow(RangeError);
    expect(() => storage.openRange(key, { start: -1, end: 5 }, etag)).toThrow(RangeError);
    expect(() => storage.openRange(key, { start: 6, end: 5 }, etag)).toThrow(RangeError);
  });

  it('does not copy the object per reader', async () => {
    // `subarray`, not `slice`: two concurrent downloads of a 4 GB object must
    // not be 8 GB of resident memory.
    const { key, etag } = await storeLarge(128 * 1024);
    const before = process.memoryUsage().heapUsed;

    await Promise.all([
      drain(await storage.openRange(key, { start: 0, end: 128 * 1024 - 1 }, etag)),
      drain(await storage.openRange(key, { start: 0, end: 128 * 1024 - 1 }, etag)),
    ]);

    // Deliberately loose — this asserts that nothing allocated a multiple of
    // the object per reader, not a precise figure a GC could move.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * 128 * 1024);
  });
});
