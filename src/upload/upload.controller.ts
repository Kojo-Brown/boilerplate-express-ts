import type { Request, Response, NextFunction } from 'express';
import { generatePresignedPutUrl, uploadToS3 } from '@/upload/s3.service';
import { AppError } from '@/lib/errors';
import { sendOk, sendCreated } from '@/lib/response';
import type { PresignBody, PresignData, UploadData } from '@/upload/upload.types';

export const uploadController = {
  async presign(
    req: Request<Record<string, string>, unknown, PresignBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { fileName, contentType } = req.body;
      const result = await generatePresignedPutUrl(fileName, contentType);

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
      const result = await uploadToS3(buffer, originalname, mimetype);

      const data: UploadData = {
        key: result.key,
        url: result.url,
        size,
        contentType: mimetype,
      };

      sendCreated(res, data);
    } catch (err) {
      next(err);
    }
  },
};
