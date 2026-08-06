import { UnknownProviderError } from '@/lib/provider-registry';
import { getStorageProvider, storageRegistry } from '@/upload/storage';
import { STORAGE_DRIVERS } from '@/upload/storage/storage.types';

// The S3 adapter's factory must never run in this suite: constructing an
// `S3Client` here would turn a registry test into an AWS SDK test.
jest.mock('@/upload/s3.service', () => ({
  generatePresignedPutUrl: jest.fn(),
  uploadToS3: jest.fn(),
  buildPublicUrl: jest.fn(),
}));

afterEach(() => {
  storageRegistry.reset();
});

describe('storageRegistry', () => {
  it('registers an adapter for every driver the config enum allows', () => {
    // The compiler already enforces this; the assertion catches the case where
    // someone widens the union by casting rather than by editing the table.
    expect([...storageRegistry.keys].sort()).toEqual([...STORAGE_DRIVERS].sort());
  });

  it('resolves each driver to an adapter that reports its own key', () => {
    for (const driver of STORAGE_DRIVERS) {
      expect(storageRegistry.resolve(driver).driver).toBe(driver);
    }
  });

  it('returns the same adapter instance on repeated resolves', () => {
    expect(storageRegistry.resolve('memory')).toBe(storageRegistry.resolve('memory'));
  });

  it('rejects a driver name that is not registered', () => {
    expect(() => storageRegistry.resolveUnknown('gcs')).toThrow(UnknownProviderError);
    expect(storageRegistry.has('gcs')).toBe(false);
  });
});

describe('getStorageProvider', () => {
  it('resolves the driver named by STORAGE_DRIVER', () => {
    // jest.setup.ts leaves STORAGE_DRIVER unset, so the schema default applies.
    expect(getStorageProvider().driver).toBe('s3');
  });

  it('returns the memoised registry instance rather than a fresh adapter', () => {
    expect(getStorageProvider()).toBe(storageRegistry.resolve('s3'));
  });
});
