import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError } from '@/lib/errors';
import { buildObjectKey } from '@/upload/object-key';
import type {
  ObjectRange,
  ObjectStat,
  PresignedUpload,
  StoredObject,
  StorageProvider,
} from '@/upload/storage/storage.types';

/** Default lifetime of a reservation handed out by `presignPut`, in seconds. */
const DEFAULT_EXPIRES_IN_SECONDS = 900;

const MEMORY_URL_PREFIX = 'memory://';

export interface StoredBlob {
  key: string;
  contentType: string;
  bytes: Buffer;
  /** Quoted strong entity-tag: the SHA-256 of `bytes`, fixed at write time. */
  etag: string;
  storedAt: Date;
}

/**
 * How much of an object `openRange` yields per chunk.
 *
 * A `Readable.from([slice])` would satisfy the interface in one line and would
 * make this adapter useless for the thing the download route exists to prove:
 * with the whole range in a single chunk there is no second `read()`, so
 * nothing downstream can ever apply backpressure and a test cannot tell a
 * streaming implementation from one that buffers. 64 KiB is Node's own default
 * file-read chunk.
 */
const CHUNK_BYTES = 64 * 1024;

export interface MemoryStorageOptions {
  /**
   * Injected clock, in epoch milliseconds. Reservation expiry is the only
   * time-dependent behaviour here, and a test that had to sleep through it
   * would be the slowest and flakiest thing in the suite.
   */
  now?: () => number;
  expiresIn?: number;
}

/**
 * The in-process driver, exposed with the extra handles a caller needs to
 * *inspect* what was stored. `stat` and `openRange` are on the production
 * contract and serve the download route; `get`, `clear` and `size` are not,
 * and exist so a test can assert against the store directly rather than
 * through it.
 */
export interface MemoryStorageProvider extends StorageProvider {
  readonly driver: 'memory';
  /** Bytes stored under a key, or `undefined` if nothing was written there. */
  get(key: string): StoredBlob | undefined;
  /**
   * Completes an upload against a URL from `presignPut`, which is what an S3
   * client PUTting to a presigned URL does out-of-process. Throws if the
   * reservation is unknown, already used, or expired.
   */
  completePresigned(presignedUrl: string, buffer: Buffer, contentType: string): StoredObject;
  /** Drops every stored object and outstanding reservation. */
  clear(): void;
  readonly size: number;
}

/**
 * A storage backend that keeps objects in a `Map` for the life of the process.
 *
 * This is for tests and for running the API locally without AWS credentials —
 * it is not durable, not shared between processes, and not a production
 * option. What makes it worth having rather than mocking `s3.service` is that
 * it exercises the real contract: keys are generated the same way, presigned
 * URLs genuinely expire and are genuinely single-use, and a driver swap in
 * `STORAGE_DRIVER` is all it takes to run the upload routes end to end.
 */
export function createMemoryStorageProvider(
  options: MemoryStorageOptions = {},
): MemoryStorageProvider {
  const now = options.now ?? ((): number => Date.now());
  const expiresIn = options.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS;

  const objects = new Map<string, StoredBlob>();
  /** key → epoch ms after which the reservation is no longer honoured. */
  const reservations = new Map<string, number>();

  function urlFor(key: string): string {
    return `${MEMORY_URL_PREFIX}${key}`;
  }

  function keyFromUrl(presignedUrl: string): string {
    if (!presignedUrl.startsWith(MEMORY_URL_PREFIX)) {
      throw new AppError(400, 'Not a memory storage URL', 'INVALID_PRESIGNED_URL');
    }
    return presignedUrl.slice(MEMORY_URL_PREFIX.length);
  }

  function store(key: string, buffer: Buffer, contentType: string): StoredObject {
    // Copied, not aliased: Multer hands out buffers backed by a pooled
    // allocation, and holding the caller's instance would let later writes
    // mutate an object that is supposedly already stored.
    const bytes = Buffer.from(buffer);
    objects.set(key, {
      key,
      contentType,
      bytes,
      // Digested once here rather than per download. A content hash is the
      // strongest validator available and is exactly what `If-Range` needs;
      // deriving a tag from the key instead would be constant across two
      // different sets of bytes at the same key, which is the one thing an
      // entity-tag may never be.
      etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
      storedAt: new Date(now()),
    });
    return { key, url: urlFor(key) };
  }

  return {
    driver: 'memory',

    presignPut(fileName: string, _contentType: string): Promise<PresignedUpload> {
      const key = buildObjectKey(fileName);
      reservations.set(key, now() + expiresIn * 1000);
      return Promise.resolve({ presignedUrl: urlFor(key), key, expiresIn });
    },

    put(buffer: Buffer, originalName: string, contentType: string): Promise<StoredObject> {
      return Promise.resolve(store(buildObjectKey(originalName), buffer, contentType));
    },

    publicUrl(key: string): string {
      return urlFor(key);
    },

    stat(key: string): Promise<ObjectStat | undefined> {
      const blob = objects.get(key);
      if (blob === undefined) return Promise.resolve(undefined);
      return Promise.resolve({
        key,
        size: blob.bytes.length,
        contentType: blob.contentType,
        etag: blob.etag,
        lastModified: blob.storedAt,
      });
    },

    openRange(key: string, range: ObjectRange, ifMatch: string): Promise<Readable> {
      const blob = objects.get(key);
      if (blob === undefined) {
        throw new AppError(404, 'No object stored under that key', 'OBJECT_NOT_FOUND');
      }
      // The window this closes is genuinely reachable in-process: `clear()` and
      // a second `completePresigned` both run between a caller's `stat` and its
      // `openRange` in a test that interleaves them, and the S3 adapter has the
      // same guard for the same reason. Answering with the new bytes under the
      // old object's `Content-Length` is a truncated or over-long body.
      if (blob.etag !== ifMatch) {
        throw new AppError(412, 'The object changed while being read', 'REPRESENTATION_CHANGED');
      }
      if (range.start < 0 || range.end >= blob.bytes.length || range.start > range.end) {
        throw new RangeError(
          `openRange: [${range.start}, ${range.end}] is outside a ${blob.bytes.length}-byte object`,
        );
      }

      // `subarray`, so no copy of the object is made per request — and then
      // handed out in chunks, so the consumer's `highWaterMark` governs how
      // much is in flight rather than the object's size doing it.
      const slice = blob.bytes.subarray(range.start, range.end + 1);
      return Promise.resolve(
        Readable.from(
          (function* chunks(): Generator<Buffer> {
            for (let offset = 0; offset < slice.length; offset += CHUNK_BYTES) {
              yield slice.subarray(offset, Math.min(offset + CHUNK_BYTES, slice.length));
            }
          })(),
        ),
      );
    },

    completePresigned(presignedUrl: string, buffer: Buffer, contentType: string): StoredObject {
      const key = keyFromUrl(presignedUrl);
      const expiresAt = reservations.get(key);

      if (expiresAt === undefined) {
        throw new AppError(403, 'No such upload reservation', 'PRESIGNED_URL_UNKNOWN');
      }
      if (now() >= expiresAt) {
        reservations.delete(key);
        throw new AppError(403, 'Upload reservation has expired', 'PRESIGNED_URL_EXPIRED');
      }

      // Single-use, like a consumed presigned URL: the reservation goes before
      // the write, so a replay cannot overwrite what the first PUT stored.
      reservations.delete(key);
      return store(key, buffer, contentType);
    },

    get(key: string): StoredBlob | undefined {
      return objects.get(key);
    },

    clear(): void {
      objects.clear();
      reservations.clear();
    },

    get size(): number {
      return objects.size;
    },
  };
}
