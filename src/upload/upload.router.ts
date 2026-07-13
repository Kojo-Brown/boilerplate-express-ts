import { Router } from 'express';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { validate } from '@/middleware/validate.middleware';
import { fileUpload } from '@/upload/upload.middleware';
import { uploadController } from '@/upload/upload.controller';
import { presignBodySchema } from '@/upload/upload.types';
import { AppError } from '@/lib/errors';

const uploadRouter = Router();

function multerErrorHandler(
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(new AppError(413, 'File exceeds the 10 MB size limit', 'FILE_TOO_LARGE'));
    } else {
      next(new AppError(400, err.message, 'UPLOAD_ERROR'));
    }
    return;
  }
  next(err);
}

uploadRouter.post(
  '/presign',
  requireAuth,
  validate({ body: presignBodySchema }),
  uploadController.presign,
);

uploadRouter.post(
  '/',
  requireAuth,
  fileUpload.single('file'),
  multerErrorHandler,
  uploadController.upload,
);

export { uploadRouter };
