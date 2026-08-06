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
