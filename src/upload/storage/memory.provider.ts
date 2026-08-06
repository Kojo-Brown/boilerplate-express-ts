import { AppError } from '@/lib/errors';
import { buildObjectKey } from '@/upload/object-key';
import type {
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
}

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
 * *inspect* what was stored — the production contract deliberately has no way
 * to read bytes back.
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
    objects.set(key, { key, contentType, bytes: Buffer.from(buffer) });
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
