import multer from 'multer';
import type { Request } from 'express';
import type { FileFilterCallback } from 'multer';
import { AppError } from '@/lib/errors';
import { ALLOWED_CONTENT_TYPES } from '@/upload/upload.types';

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_CONTENT_TYPES);

export const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void {
    if (ALLOWED_MIME_SET.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          415,
          `Unsupported file type: ${file.mimetype}. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
          'UNSUPPORTED_MEDIA_TYPE',
        ),
      );
    }
  },
});
