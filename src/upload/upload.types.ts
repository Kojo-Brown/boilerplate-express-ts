import { z } from 'zod';
import { OBJECT_ID_PATTERN } from '@/upload/object-key';

export const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const presignBodySchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  size: z.number().int().positive().max(10 * 1024 * 1024),
});

export type PresignBody = z.infer<typeof presignBodySchema>;

/**
 * The one path parameter the download route takes.
 *
 * Validated at the edge like every other input, which here is load-bearing
 * rather than routine: this string becomes part of a storage key, so the
 * difference between a 422 and a path traversal is this schema. `regex` rather
 * than `uuid()` because the extension is part of the id — `buildObjectKey`
 * keeps it so that a stored object carries a hint of what it is.
 */
export const downloadParamsSchema = z.object({
  objectId: z.string().regex(OBJECT_ID_PATTERN, 'Not a well-formed object id'),
});

export type DownloadParams = z.infer<typeof downloadParamsSchema>;

export interface PresignData {
  presignedUrl: string;
  key: string;
  expiresIn: number;
}

export interface UploadData {
  key: string;
  url: string;
  size: number;
  contentType: string;
  /**
   * Digest of the bytes that were stored, so a client can verify the transfer
   * without reading the object back.
   *
   * Computed on a worker thread once the payload is large enough to be worth
   * one — see `upload.checksum.ts`.
   */
  checksum: {
    algorithm: string;
    hex: string;
  };
}
