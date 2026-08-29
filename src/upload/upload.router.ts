import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { validate } from '@/middleware/validate.middleware';
import { fileUpload } from '@/upload/upload.middleware';
import { uploadController } from '@/upload/upload.controller';
import { downloadController } from '@/upload/download.controller';
import { downloadParamsSchema, presignBodySchema } from '@/upload/upload.types';

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

// Last, so the literal `/presign` above can never be shadowed by this pattern —
// they differ by method today, and a route ordering that only works because of
// that is one `GET /presign` away from being wrong.
//
// Express routes HEAD to the GET handler, which is what makes `curl -I` return
// the size and `Accept-Ranges` a client needs before it starts a resumable
// download; `sendByteRange` ends the response without a body for it.
uploadRouter.get(
  '/:objectId',
  requireAuth,
  validate({ params: downloadParamsSchema }),
  downloadController.download,
);

export { uploadRouter };
