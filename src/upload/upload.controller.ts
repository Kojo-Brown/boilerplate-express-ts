import type { Request, Response, NextFunction } from 'express';
import { getStorageProvider } from '@/upload/storage';
import { AppError } from '@/lib/errors';
import { sendOk, sendCreated } from '@/lib/response';
import { env } from '@/config/env';
import { CPU_WORKER_POOL } from '@/container/tokens';
import { scopeOf } from '@/middleware/container.middleware';
import { computeChecksum } from '@/upload/upload.checksum';
import type { PresignBody, PresignData, UploadData } from '@/upload/upload.types';

export const uploadController = {
  async presign(
    req: Request<Record<string, string>, unknown, PresignBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { fileName, contentType } = req.body;
      // Resolved per request, not captured at module load: the registry
      // memoises, and binding the adapter here keeps the controller unaware of
      // which backend is configured.
      const result = await getStorageProvider().presignPut(fileName, contentType);

      const data: PresignData = {
        presignedUrl: result.presignedUrl,
        key: result.key,
        expiresIn: result.expiresIn,
      };

      sendOk(res, data);
    } catch (err) {
      next(err);
    }
  },

  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        next(new AppError(400, 'No file provided', 'NO_FILE'));
        return;
      }

      const { buffer, mimetype, originalname, size } = req.file;

      // Before the store, not after: the digest describes the bytes this
      // service accepted, and computing it from anything other than the exact
      // buffer that was handed to the provider would let the two disagree
      // without anything noticing.
      //
      // Resolved per request for the same reason the storage provider is —
      // and it costs nothing when the file is small, because the pool spawns
      // threads lazily and `computeChecksum` does not ask it for one below the
      // offload threshold.
      const checksum = await computeChecksum(buffer, {
        pool: scopeOf(req).resolve(CPU_WORKER_POOL),
        offloadMinBytes: env.WORKER_POOL_OFFLOAD_MIN_BYTES,
      });

      const result = await getStorageProvider().put(buffer, originalname, mimetype);

      const data: UploadData = {
        key: result.key,
        url: result.url,
        size,
        contentType: mimetype,
        checksum: { algorithm: checksum.algorithm, hex: checksum.hex },
      };

      sendCreated(res, data);
    } catch (err) {
      next(err);
    }
  },
};
