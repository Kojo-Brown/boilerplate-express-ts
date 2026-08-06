import { env } from '@/config/env';
import { createProviderRegistry } from '@/lib/provider-registry';
import type { ProviderRegistry } from '@/lib/provider-registry';
import { createMemoryStorageProvider } from '@/upload/storage/memory.provider';
import { createS3StorageProvider } from '@/upload/storage/s3.provider';
import type { StorageDriver, StorageProvider } from '@/upload/storage/storage.types';

/**
 * The registration table for storage backends.
 *
 * `StorageDriver` is pinned explicitly rather than inferred, which is what
 * makes this exhaustive: add a driver to `STORAGE_DRIVERS` and this object stops
 * satisfying `Record<StorageDriver, …>` until its adapter is registered here.
 * The failure lands at the point of registration, not at some later call that
 * happens to pass the new key.
 *
 * Factories run on first resolve, so a deployment on `memory` never constructs
 * an `S3Client` and never needs AWS credentials to exist.
 */
export const storageRegistry: ProviderRegistry<StorageDriver, StorageProvider> =
  createProviderRegistry<StorageDriver, StorageProvider>('storage', {
    s3: createS3StorageProvider,
    memory: (): StorageProvider => createMemoryStorageProvider(),
  });

/**
 * The provider this deployment is configured for. Call it per request rather
 * than caching the result in a module constant — the registry already
 * memoises, and a module constant would freeze the driver at import time,
 * before a test has had any chance to point `STORAGE_DRIVER` elsewhere.
 */
export function getStorageProvider(): StorageProvider {
  return storageRegistry.resolve(env.STORAGE_DRIVER);
}

export type {
  PresignedUpload,
  StorageDriver,
  StorageProvider,
  StoredObject,
} from '@/upload/storage/storage.types';
export { STORAGE_DRIVERS } from '@/upload/storage/storage.types';
