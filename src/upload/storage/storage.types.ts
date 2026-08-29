import type { Readable } from 'node:stream';

/**
 * The single source of truth for which storage backends exist.
 *
 * `env.STORAGE_DRIVER` validates against this list and the provider registry is
 * keyed by it, so adding a driver here is a compile error until an adapter is
 * registered for it. Keep this module free of *value* imports — `config/env`
 * depends on it, and anything it pulled in would be dragged into env parsing at
 * boot. `import type` is erased entirely and costs nothing at runtime, which is
 * why the stream type above is allowed and an `import { Readable }` would not
 * be.
 */
export const STORAGE_DRIVERS = ['s3', 'memory'] as const;

export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** A URL the client may PUT bytes to directly, plus where they will land. */
export interface PresignedUpload {
  presignedUrl: string;
  key: string;
  expiresIn: number;
}

/** Where bytes ended up after the API itself wrote them. */
export interface StoredObject {
  key: string;
  url: string;
}

/** An inclusive byte interval within a stored object. */
export interface ObjectRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Everything needed to answer a conditional or ranged GET *without* reading a
 * byte of the object.
 *
 * That is the whole reason this is separate from opening a stream: a 304 and a
 * 416 are both complete answers built entirely out of these five fields, and a
 * download endpoint that had to open the object to produce them would transfer
 * the thing it is about to tell the client not to transfer.
 */
export interface ObjectStat {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  /**
   * A **strong** entity-tag, quotes included, in the exact form it goes on the
   * wire.
   *
   * Strong is not a preference: `If-Range` is evaluated by strong comparison,
   * so a weak validator here would silently disable resumable downloads for
   * every client that sends one. Each adapter derives it from something that
   * provably changes with the bytes — a digest, or S3's own `ETag`.
   */
  readonly etag: string;
  readonly lastModified: Date;
}

/**
 * What the upload feature needs from a storage backend, and nothing more —
 * no bucket, no region, no SDK types. Every adapter owns its own credentials
 * and URL construction, which is what lets the controller stay identical
 * across drivers.
 */
export interface StorageProvider {
  /** Registry key this adapter was built for; handy in logs and responses. */
  readonly driver: StorageDriver;

  /**
   * Issues a URL the client uploads to directly, bypassing this process.
   * `fileName` only contributes its extension — the key is server-generated so
   * a client cannot choose where its bytes land.
   */
  presignPut(fileName: string, contentType: string): Promise<PresignedUpload>;

  /** Writes bytes that already passed through this process (Multer buffers). */
  put(buffer: Buffer, originalName: string, contentType: string): Promise<StoredObject>;

  /** The stable, publicly addressable URL for a key this adapter produced. */
  publicUrl(key: string): string;

  /**
   * Metadata for a stored object, or `undefined` if there is nothing at `key`.
   *
   * "Not there" is a return value rather than a thrown error because it is not
   * exceptional — it is what a client asking for a deleted or mistyped key
   * looks like, and the route turns it into a 404. Every other failure (denied,
   * unreachable, malformed response) still throws.
   */
  stat(key: string): Promise<ObjectStat | undefined>;

  /**
   * Opens a stream over an inclusive byte interval of a stored object.
   *
   * `ifMatch` is the `etag` from the `stat` the caller made its decisions with,
   * and closing that window is its entire job: between the `stat` and this call
   * the object may have been replaced, and serving *those* bytes under a
   * `Content-Range` and `Content-Length` computed from the previous
   * representation is how a resumed download ends up as a corrupt file that
   * every checksum downstream blames on the network. An adapter that cannot
   * enforce it must say so rather than ignore it.
   */
  openRange(key: string, range: ObjectRange, ifMatch: string): Promise<Readable>;
}
