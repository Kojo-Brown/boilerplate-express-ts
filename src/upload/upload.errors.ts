import { MulterError } from 'multer';
import type { ErrorTranslator } from '@/lib/error-translators';
import { MAX_FILE_SIZE_BYTES } from '@/upload/upload.middleware';

const MAX_FILE_SIZE_MB = Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024));

const MULTER_RESPONSES: Record<string, { statusCode: number; code: string; message: string }> = {
  LIMIT_FILE_SIZE: {
    statusCode: 413,
    code: 'FILE_TOO_LARGE',
    message: `File exceeds the ${String(MAX_FILE_SIZE_MB)}MB limit`,
  },
  LIMIT_FILE_COUNT: {
    statusCode: 400,
    code: 'TOO_MANY_FILES',
    message: 'Too many files in the request',
  },
  LIMIT_UNEXPECTED_FILE: {
    statusCode: 400,
    code: 'UNEXPECTED_FILE_FIELD',
    message: 'File was sent under an unexpected field name',
  },
  LIMIT_PART_COUNT: {
    statusCode: 400,
    code: 'TOO_MANY_PARTS',
    message: 'Too many parts in the multipart request',
  },
  LIMIT_FIELD_KEY: {
    statusCode: 400,
    code: 'FIELD_NAME_TOO_LONG',
    message: 'A form field name was too long',
  },
  LIMIT_FIELD_VALUE: {
    statusCode: 400,
    code: 'FIELD_VALUE_TOO_LONG',
    message: 'A form field value was too long',
  },
  LIMIT_FIELD_COUNT: {
    statusCode: 400,
    code: 'TOO_MANY_FIELDS',
    message: 'Too many form fields in the request',
  },
};

/**
 * Every `MulterError` describes something the *client* did — a file over the
 * limit, a field Multer was not told to expect. Left untranslated they all
 * surface as 500s, so an oversized upload looks like a server crash and the
 * client has no reason to stop retrying it.
 *
 * Any future Multer code that is not in the table still maps to a 400 rather
 * than a 500: the class of the error is already known to be client-caused.
 */
export const multerErrorTranslator: ErrorTranslator = (err) => {
  if (!(err instanceof MulterError)) return null;
  return (
    MULTER_RESPONSES[err.code] ?? {
      statusCode: 400,
      code: 'UPLOAD_ERROR',
      message: 'The uploaded file could not be processed',
    }
  );
};
