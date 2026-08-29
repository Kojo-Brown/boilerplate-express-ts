import { Readable } from 'node:stream';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '@/lib/errors';
import { downloadController } from '@/upload/download.controller';
import type { DownloadParams } from '@/upload/upload.types';
import type { ObjectRange, ObjectStat, StorageProvider } from '@/upload/storage/storage.types';

jest.mock('@/upload/storage', () => ({
  getStorageProvider: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-require-imports -- the mocked module's
   handle has to be read after `jest.mock` has replaced it, and an `import` of
   it would be hoisted above that. */
const { getStorageProvider } = require('@/upload/storage') as {
  getStorageProvider: jest.MockedFunction<() => StorageProvider>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const OBJECT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301.png';
const STAT: ObjectStat = {
  key: `uploads/${OBJECT_ID}`,
  size: 5,
  contentType: 'image/png',
  etag: '"current"',
  lastModified: new Date('2026-01-01T00:00:00.000Z'),
};

const stat = jest.fn<Promise<ObjectStat | undefined>, [string]>();
const openRange = jest.fn<Promise<Readable>, [string, ObjectRange, string]>();

function makeReq(objectId = OBJECT_ID): Request<DownloadParams> {
  return {
    method: 'GET',
    headers: {},
    params: { objectId },
  } as unknown as Request<DownloadParams>;
}

function makeRes(): Response {
  const res: Record<string, unknown> = {
    statusCode: 200,
    headersSent: false,
    setHeader: jest.fn(),
    status: jest.fn((): unknown => res),
    json: jest.fn((): unknown => res),
    end: jest.fn((): unknown => res),
  };
  return res as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  getStorageProvider.mockReturnValue({
    driver: 'memory',
    presignPut: jest.fn(),
    put: jest.fn(),
    publicUrl: (key: string) => `memory://${key}`,
    stat,
    openRange,
  } as unknown as StorageProvider);
  stat.mockResolvedValue(STAT);
  openRange.mockResolvedValue(Readable.from([Buffer.from('bytes')]));
});

describe('downloadController.download', () => {
  it('reads the object under the prefix this service owns, not one the client named', async () => {
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(), makeRes(), next);

    expect(stat).toHaveBeenCalledWith(`uploads/${OBJECT_ID}`);
  });

  it('opens the read pinned to the exact representation it measured', async () => {
    // The window between `stat` and `openRange` is where an object can be
    // replaced, and serving the new bytes under the old `Content-Length` is a
    // corrupt download rather than an error. Passing the tag through is what
    // makes that a failure instead.
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(), makeRes(), next);

    expect(openRange).toHaveBeenCalledWith(
      `uploads/${OBJECT_ID}`,
      { start: 0, end: 4 },
      '"current"',
    );
  });

  it('answers 404 for a key with nothing stored under it', async () => {
    stat.mockResolvedValue(undefined);
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(), makeRes(), next);

    const err = (next as jest.Mock).mock.calls[0]?.[0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('OBJECT_NOT_FOUND');
    expect(openRange).not.toHaveBeenCalled();
  });

  it('hands a backend failure to the error middleware rather than answering itself', async () => {
    stat.mockRejectedValue(new AppError(502, 'upstream said no', 'STORAGE_UNAVAILABLE'));
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(), makeRes(), next);

    expect((next as jest.Mock).mock.calls[0]?.[0]).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('refuses an id that was never validated at the edge', async () => {
    // The schema on the route is the real check; this is the backstop for a
    // caller that forgot it, and it must not build a key out of the input.
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq('../../etc/passwd'), makeRes(), next);

    expect((next as jest.Mock).mock.calls[0]?.[0]).toBeInstanceOf(RangeError);
    expect(stat).not.toHaveBeenCalled();
  });
});
