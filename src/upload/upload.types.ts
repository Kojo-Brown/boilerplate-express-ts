import { z } from 'zod';

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
