import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { validate } from '@/middleware/validate.middleware';
import { fileUpload } from '@/upload/upload.middleware';
import { uploadController } from '@/upload/upload.controller';
import { presignBodySchema } from '@/upload/upload.types';

const uploadRouter: Router = Router();

// Multer errors are mapped by `multerErrorTranslator`, registered in the
// composition root. This router used to carry its own error-handling middleware
// to do that, which only existed because the global handler could not be
// extended; that copy is gone.

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
  uploadController.upload,
);

export { uploadRouter };
