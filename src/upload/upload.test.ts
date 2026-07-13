import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@/lib/errors';

jest.mock('@/upload/s3.service', () => ({
  generatePresignedPutUrl: jest.fn(),
  uploadToS3: jest.fn(),
  buildPublicUrl: jest.fn(),
}));

import { uploadController } from '@/upload/upload.controller';
import * as s3Service from '@/upload/s3.service';
import type { PresignBody } from '@/upload/upload.types';

type MockedFn<T extends (...args: unknown[]) => unknown> = jest.MockedFunction<T>;

const mockGeneratePresignedPutUrl = s3Service.generatePresignedPutUrl as MockedFn<
  typeof s3Service.generatePresignedPutUrl
>;
const mockUploadToS3 = s3Service.uploadToS3 as MockedFn<typeof s3Service.uploadToS3>;

function makeRes(): Response {
  const res = {} as Response;
  const json = jest.fn().mockReturnValue(res);
  const end = jest.fn().mockReturnValue(res);
  const status = jest.fn().mockReturnValue(res);
  Object.assign(res, { json, end, status });
  return res;
}

function makeNext(): jest.MockedFunction<NextFunction> {
  return jest.fn() as jest.MockedFunction<NextFunction>;
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('uploadController.presign', () => {
  it('responds 200 with presigned URL data on success', async () => {
    mockGeneratePresignedPutUrl.mockResolvedValue({
      presignedUrl: 'https://s3.example.com/presigned-put-url',
      key: 'uploads/abc-123.jpg',
      expiresIn: 3600,
    });

    const req = {
      body: { fileName: 'photo.jpg', contentType: 'image/jpeg', size: 2048 } as PresignBody,
    } as Request<Record<string, string>, unknown, PresignBody>;
    const res = makeRes();
    const next = makeNext();

    await uploadController.presign(req, res, next);

    expect(mockGeneratePresignedPutUrl).toHaveBeenCalledWith('photo.jpg', 'image/jpeg');
    expect(res.status as jest.Mock).toHaveBeenCalledWith(200);
    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      data: {
        presignedUrl: 'https://s3.example.com/presigned-put-url',
        key: 'uploads/abc-123.jpg',
        expiresIn: 3600,
      },
      meta: null,
      error: null,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards S3 errors to next without sending a response', async () => {
    const s3Error = new Error('S3 service unavailable');
    mockGeneratePresignedPutUrl.mockRejectedValue(s3Error);

    const req = {
      body: { fileName: 'photo.jpg', contentType: 'image/jpeg', size: 2048 } as PresignBody,
    } as Request<Record<string, string>, unknown, PresignBody>;
    const res = makeRes();
    const next = makeNext();

    await uploadController.presign(req, res, next);

    expect(next).toHaveBeenCalledWith(s3Error);
    expect(res.status as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('uploadController.upload', () => {
  const mockFile = {
    fieldname: 'file',
    originalname: 'avatar.png',
    encoding: '7bit',
    mimetype: 'image/png',
    buffer: Buffer.from('fake-image-data'),
    size: 15,
  } as Express.Multer.File;

  it('responds 201 with upload data on success', async () => {
    mockUploadToS3.mockResolvedValue({
      key: 'uploads/uuid-123.png',
      url: 'https://test-bucket.s3.us-east-1.amazonaws.com/uploads/uuid-123.png',
    });

    const req = { file: mockFile } as Request;
    const res = makeRes();
    const next = makeNext();

    await uploadController.upload(req, res, next);

    expect(mockUploadToS3).toHaveBeenCalledWith(
      mockFile.buffer,
      mockFile.originalname,
      mockFile.mimetype,
    );
    expect(res.status as jest.Mock).toHaveBeenCalledWith(201);
    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      data: {
        key: 'uploads/uuid-123.png',
        url: 'https://test-bucket.s3.us-east-1.amazonaws.com/uploads/uuid-123.png',
        size: 15,
        contentType: 'image/png',
      },
      meta: null,
      error: null,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next with AppError(400) when req.file is absent', async () => {
    const req = { file: undefined } as Request;
    const res = makeRes();
    const next = makeNext();

    await uploadController.upload(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = (next as jest.Mock).mock.calls[0]?.[0] as AppError;
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('NO_FILE');
    expect(res.status as jest.Mock).not.toHaveBeenCalled();
  });

  it('forwards S3 upload errors to next without sending a response', async () => {
    const s3Error = new Error('PutObject failed');
    mockUploadToS3.mockRejectedValue(s3Error);

    const req = { file: mockFile } as Request;
    const res = makeRes();
    const next = makeNext();

    await uploadController.upload(req, res, next);

    expect(next).toHaveBeenCalledWith(s3Error);
    expect(res.status as jest.Mock).not.toHaveBeenCalled();
  });
});
