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

function makeReq(
  objectId = OBJECT_ID,
  headers: Record<string, string> = {},
): Request<DownloadParams> {
  return {
    method: 'GET',
    headers,
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

/**
 * Content negotiation (RFC 9110 §12.5.1), the kata's cycle 6 — and the first
 * caller `@/http/accept` has.
 *
 * A stored object has exactly one representation and this service cannot
 * transcode it, so `Accept` is answerable here in a way it is not on a route
 * that renders its own body: either the client will take what is stored or
 * nothing can satisfy it. Before this, `Accept` was ignored and a client that
 * asked for `image/jpeg` was sent a PNG with a 200 on it — a client that
 * believes a status code then hands those bytes to its decoder.
 */
/**
 * The negotiation assertion for a representation that *is* acceptable.
 *
 * Not `expect(next).not.toHaveBeenCalled()`: `makeRes()` is a bag of mocks with
 * nothing to pipe into, so `sendByteRange` reaches the stream and fails there
 * on every one of these cases, acceptable or not. What this file can establish
 * is that negotiation did not refuse the request — the read was reached, and
 * whatever came back is not a 406. The rest of the path is asserted over a real
 * socket in `src/tests/e2e/download.e2e.test.ts`.
 */
function expectNegotiationAllowed(next: NextFunction): void {
  expect(openRange).toHaveBeenCalled();
  const err = (next as jest.Mock).mock.calls[0]?.[0] as AppError | undefined;
  expect(err?.statusCode).not.toBe(406);
}

describe('downloadController.download — Accept', () => {
  it('serves the stored representation when the client will take it', async () => {
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(OBJECT_ID, { accept: 'image/png' }), makeRes(), next);

    expectNegotiationAllowed(next);
  });

  it('serves it under a type wildcard, and under the full wildcard', async () => {
    for (const accept of ['image/*', '*/*', 'text/html, image/*;q=0.2']) {
      jest.clearAllMocks();
      stat.mockResolvedValue(STAT);
      openRange.mockResolvedValue(Readable.from([Buffer.from('bytes')]));
      const next = jest.fn() as unknown as NextFunction;

      await downloadController.download(makeReq(OBJECT_ID, { accept }), makeRes(), next);

      expectNegotiationAllowed(next);
    }
  });

  it('serves it when the client sent no Accept at all', async () => {
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(), makeRes(), next);

    expectNegotiationAllowed(next);
  });

  it('answers 406 when nothing the client accepts is what is stored', async () => {
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(
      makeReq(OBJECT_ID, { accept: 'image/jpeg, text/html' }),
      makeRes(),
      next,
    );

    const err = (next as jest.Mock).mock.calls[0]?.[0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(406);
    expect(err.code).toBe('NOT_ACCEPTABLE');
    // The point of refusing before the read: a 406 transfers nothing, so it
    // must not have cost a request to the object store.
    expect(openRange).not.toHaveBeenCalled();
  });

  it('answers 406 for a representation the client refused by weight', async () => {
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(
      makeReq(OBJECT_ID, { accept: '*/*, image/png;q=0' }),
      makeRes(),
      next,
    );

    expect(((next as jest.Mock).mock.calls[0]?.[0] as AppError).statusCode).toBe(406);
    expect(openRange).not.toHaveBeenCalled();
  });

  /**
   * Negotiation is a statement about a representation, so it cannot run before
   * the object is known to exist: the stored media type is the only offer there
   * is. A 406 for a key holding nothing would also be a probe oracle — it would
   * answer differently for a key that exists and one that does not, to a caller
   * whose `Accept` matches nothing either way.
   */
  it('answers 404 rather than 406 when the object does not exist', async () => {
    stat.mockResolvedValue(undefined);
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(
      makeReq(OBJECT_ID, { accept: 'image/jpeg' }),
      makeRes(),
      next,
    );

    const err = (next as jest.Mock).mock.calls[0]?.[0] as AppError;
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('OBJECT_NOT_FOUND');
  });

  /**
   * A 406 takes precedence over a 304: both are empty responses, but they say
   * different things, and a client told "not modified" caches the agreement
   * that it may reuse a representation this request just established it cannot
   * use.
   */
  it('answers 406 rather than 304 for an unacceptable representation the client already holds', async () => {
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(
      makeReq(OBJECT_ID, { accept: 'image/jpeg', 'if-none-match': '"current"' }),
      makeRes(),
      next,
    );

    expect(((next as jest.Mock).mock.calls[0]?.[0] as AppError).statusCode).toBe(406);
  });

  /**
   * A field this parser cannot read is ignored rather than refused, so a
   * client's header bug does not become a 406 that reads as "we have nothing
   * you asked for". See `selectMediaType`.
   */
  it('serves the object when the Accept field is malformed', async () => {
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(
      makeReq(OBJECT_ID, { accept: 'image/png;q=bogus' }),
      makeRes(),
      next,
    );

    expectNegotiationAllowed(next);
  });

  /**
   * The stored media type may carry parameters of its own, and the client's
   * bare range is the broader statement, so it still matches.
   */
  it('matches a bare range against a stored type that carries parameters', async () => {
    stat.mockResolvedValue({ ...STAT, contentType: 'text/csv; charset=utf-8' });
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(OBJECT_ID, { accept: 'text/csv' }), makeRes(), next);

    expectNegotiationAllowed(next);
  });

  /**
   * And a stored type this service cannot itself parse must not become a 406 —
   * that would make an object unreachable because of how it was labelled at
   * upload, which is a data problem and not a negotiation one.
   */
  it('serves an object whose stored media type is unparseable', async () => {
    stat.mockResolvedValue({ ...STAT, contentType: 'not a media type' });
    const next = jest.fn() as unknown as NextFunction;

    await downloadController.download(makeReq(OBJECT_ID, { accept: 'image/png' }), makeRes(), next);

    expectNegotiationAllowed(next);
  });
});
