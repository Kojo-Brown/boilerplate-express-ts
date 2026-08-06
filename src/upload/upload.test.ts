import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@/lib/errors';
import type { StorageProvider } from '@/upload/storage';

// The controller resolves its backend from the registry, so that is what gets
// stubbed. These cases are about the controller's own behaviour — status codes,
// envelope shape, error forwarding — and they should hold for every driver.
jest.mock('@/upload/storage', () => ({
  getStorageProvider: jest.fn(),
}));

import { uploadController } from '@/upload/upload.controller';
import { getStorageProvider } from '@/upload/storage';
import type { PresignBody } from '@/upload/upload.types';

// `unknown[]` as the parameter constraint is contravariantly wrong — no
// concretely-typed function satisfies it. `never[]` is the constraint that
// actually accepts every function signature.
type MockedFn<T extends (...args: never[]) => unknown> = jest.MockedFunction<T>;

const mockGetStorageProvider = getStorageProvider as MockedFn<typeof getStorageProvider>;
const mockPresignPut = jest.fn() as MockedFn<StorageProvider['presignPut']>;
const mockPut = jest.fn() as MockedFn<StorageProvider['put']>;

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
  mockGetStorageProvider.mockReturnValue({
    driver: 'memory',
    presignPut: mockPresignPut,
    put: mockPut,
    publicUrl: (key: string) => `memory://${key}`,
  });
});

describe('uploadController.presign', () => {
  it('responds 200 with presigned URL data on success', async () => {
    mockPresignPut.mockResolvedValue({
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

    expect(mockPresignPut).toHaveBeenCalledWith('photo.jpg', 'image/jpeg');
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

  it('forwards storage errors to next without sending a response', async () => {
    const storageError = new Error('storage backend unavailable');
    mockPresignPut.mockRejectedValue(storageError);

    const req = {
      body: { fileName: 'photo.jpg', contentType: 'image/jpeg', size: 2048 } as PresignBody,
    } as Request<Record<string, string>, unknown, PresignBody>;
    const res = makeRes();
    const next = makeNext();

    await uploadController.presign(req, res, next);

    expect(next).toHaveBeenCalledWith(storageError);
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
    mockPut.mockResolvedValue({
      key: 'uploads/uuid-123.png',
      url: 'https://test-bucket.s3.us-east-1.amazonaws.com/uploads/uuid-123.png',
    });

    const req = { file: mockFile } as Request;
    const res = makeRes();
    const next = makeNext();

    await uploadController.upload(req, res, next);

    expect(mockPut).toHaveBeenCalledWith(
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

  it('forwards storage write errors to next without sending a response', async () => {
    const storageError = new Error('write failed');
    mockPut.mockRejectedValue(storageError);

    const req = { file: mockFile } as Request;
    const res = makeRes();
    const next = makeNext();

    await uploadController.upload(req, res, next);

    expect(next).toHaveBeenCalledWith(storageError);
    expect(res.status as jest.Mock).not.toHaveBeenCalled();
  });
});
