import { MulterError } from 'multer';
import { multerErrorTranslator } from '@/upload/upload.errors';
import { MAX_FILE_SIZE_BYTES } from '@/upload/upload.middleware';

describe('multerErrorTranslator', () => {
  it('maps an oversized file to 413, not a 500', () => {
    expect(multerErrorTranslator(new MulterError('LIMIT_FILE_SIZE', 'file'))).toMatchObject({
      statusCode: 413,
      code: 'FILE_TOO_LARGE',
    });
  });

  it('states the actual limit in the 413 message', () => {
    const expectedMb = Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024));
    const translated = multerErrorTranslator(new MulterError('LIMIT_FILE_SIZE', 'file'));
    expect(translated?.message).toContain(`${String(expectedMb)}MB`);
  });

  it('maps an unexpected field name to 400', () => {
    expect(multerErrorTranslator(new MulterError('LIMIT_UNEXPECTED_FILE', 'avatar'))).toMatchObject(
      { statusCode: 400, code: 'UNEXPECTED_FILE_FIELD' },
    );
  });

  it('maps too many files to 400', () => {
    expect(multerErrorTranslator(new MulterError('LIMIT_FILE_COUNT', 'file'))).toMatchObject({
      statusCode: 400,
      code: 'TOO_MANY_FILES',
    });
  });

  it('falls back to a generic 400 for an unlisted Multer code', () => {
    const unknown = new MulterError('LIMIT_FILE_SIZE', 'file');
    // Simulate a code this table has never seen: still client-caused, so 4xx.
    (unknown as { code: string }).code = 'LIMIT_SOMETHING_NEW';

    expect(multerErrorTranslator(unknown)).toEqual({
      statusCode: 400,
      code: 'UPLOAD_ERROR',
      message: 'The uploaded file could not be processed',
    });
  });

  it('declines anything that is not a MulterError', () => {
    expect(multerErrorTranslator(new Error('LIMIT_FILE_SIZE'))).toBeNull();
    expect(multerErrorTranslator(null)).toBeNull();
  });
});
