/**
 * The single source of truth for which storage backends exist.
 *
 * `env.STORAGE_DRIVER` validates against this list and the provider registry is
 * keyed by it, so adding a driver here is a compile error until an adapter is
 * registered for it. Keep this module free of imports — `config/env` depends on
 * it, and anything it pulled in would be dragged into env parsing at boot.
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
}
