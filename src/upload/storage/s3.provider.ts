import type { Readable } from 'node:stream';
import {
  buildPublicUrl,
  generatePresignedPutUrl,
  getS3ObjectRange,
  headS3Object,
  uploadToS3,
} from '@/upload/s3.service';
import type {
  ObjectRange,
  ObjectStat,
  PresignedUpload,
  StoredObject,
  StorageProvider,
} from '@/upload/storage/storage.types';

/**
 * Adapts the existing S3 service to the driver-agnostic contract.
 *
 * The AWS specifics — client construction, bucket, region, presigner — stay in
 * `s3.service`; this file is only the shape change. Keeping the seam that thin
 * means the adapter has nothing to test that `s3.service` does not already
 * cover, and there is no second copy of the key-building rules to drift.
 */
export function createS3StorageProvider(): StorageProvider {
  return {
    driver: 's3',

    async presignPut(fileName: string, contentType: string): Promise<PresignedUpload> {
      return generatePresignedPutUrl(fileName, contentType);
    },

    async put(buffer: Buffer, originalName: string, contentType: string): Promise<StoredObject> {
      return uploadToS3(buffer, originalName, contentType);
    },

    publicUrl(key: string): string {
      return buildPublicUrl(key);
    },

    async stat(key: string): Promise<ObjectStat | undefined> {
      return headS3Object(key);
    },

    async openRange(key: string, range: ObjectRange, ifMatch: string): Promise<Readable> {
      return getS3ObjectRange(key, range, ifMatch);
    },
  };
}
