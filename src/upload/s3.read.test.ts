import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { AppError } from '@/lib/errors';
import { getS3ObjectRange, headS3Object } from '@/upload/s3.service';

/**
 * The read half of the S3 adapter, against a stubbed client.
 *
 * What is worth pinning here is not that the SDK works — it is the translation
 * layer either side of it: which SDK exception means "not there" rather than
 * "broken", that a `Range` is pushed down to S3 instead of being applied after
 * a full transfer, and that `IfMatch` is actually sent. All three are things a
 * later refactor can drop without any type error.
 */

const send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({
      send: (...args: unknown[]): unknown => send(...args),
    })),
  };
});

/** Builds the SDK's shape for a service error the client did not model. */
function serviceException(statusCode: number): S3ServiceException {
  return new S3ServiceException({
    name: 'PreconditionFailed',
    $fault: 'client',
    $metadata: { httpStatusCode: statusCode },
    message: 'At least one of the pre-conditions you specified did not hold',
  });
}

beforeEach(() => {
  send.mockReset();
});

describe('headS3Object', () => {
  it('maps a HeadObject response onto the stat the download path needs', async () => {
    const lastModified = new Date('2026-02-01T00:00:00.000Z');
    send.mockResolvedValue({
      ContentLength: 4096,
      ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      ContentType: 'application/pdf',
      LastModified: lastModified,
    });

    const stat = await headS3Object('uploads/a.pdf');

    expect(stat).toEqual({
      key: 'uploads/a.pdf',
      size: 4096,
      // Passed through untouched: S3's ETag arrives quoted, and re-quoting it
      // would produce a tag matching nothing a previous response handed out.
      etag: '"d41d8cd98f00b204e9800998ecf8427e"',
      contentType: 'application/pdf',
      lastModified,
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('falls back to an opaque content type rather than sending none', async () => {
    send.mockResolvedValue({ ContentLength: 1, ETag: '"x"' });

    await expect(headS3Object('uploads/a.bin')).resolves.toMatchObject({
      contentType: 'application/octet-stream',
    });
  });

  it.each([
    ['NotFound', (): Error => new NotFound({ $metadata: {}, message: 'missing' })],
    [
      'NoSuchKey',
      (): Error => new NoSuchKey({ $metadata: {}, message: 'missing' }),
    ],
  ])('reports absence rather than throwing for %s', async (_name, make) => {
    // S3 answers a HEAD on a missing key with a bare 404 and no error code, so
    // the SDK raises `NotFound` where a GET would raise `NoSuchKey`. Treating
    // both as absence is also what makes this correct against the
    // S3-compatible stores that pick the other one.
    send.mockRejectedValue(make());

    await expect(headS3Object('uploads/gone.png')).resolves.toBeUndefined();
  });

  it('propagates a failure that is not an absence', async () => {
    send.mockRejectedValue(serviceException(503));

    await expect(headS3Object('uploads/a.png')).rejects.toBeInstanceOf(S3ServiceException);
  });

  it('refuses a response with no length or entity-tag rather than inventing one', async () => {
    // Both are optional in the model and load-bearing here: the range
    // arithmetic and the `If-Range` comparison are built out of them, so a zero
    // default would serve an empty body under a 200.
    send.mockResolvedValue({ ETag: '"x"' });
    await expect(headS3Object('uploads/a.png')).rejects.toMatchObject({
      statusCode: 502,
      code: 'STORAGE_METADATA_MISSING',
    });

    send.mockResolvedValue({ ContentLength: 10 });
    await expect(headS3Object('uploads/a.png')).rejects.toMatchObject({
      code: 'STORAGE_METADATA_MISSING',
    });
  });
});

describe('getS3ObjectRange', () => {
  it('pushes the range down to S3 and pins the read to one representation', async () => {
    send.mockResolvedValue({ Body: Readable.from([Buffer.from('slice')]) });

    const stream = await getS3ObjectRange('uploads/a.pdf', { start: 100, end: 199 }, '"v1"');

    const command = send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toMatchObject({
      Key: 'uploads/a.pdf',
      // Fetching the whole object and discarding all but a slice would pay for
      // the entire transfer to serve 100 bytes of it.
      Range: 'bytes=100-199',
      IfMatch: '"v1"',
    });
    expect(stream).toBeInstanceOf(Readable);
  });

  it('turns a missing object into a 404', async () => {
    send.mockRejectedValue(new NoSuchKey({ $metadata: {}, message: 'missing' }));

    await expect(
      getS3ObjectRange('uploads/gone.pdf', { start: 0, end: 9 }, '"v1"'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'OBJECT_NOT_FOUND' });
  });

  it('turns a failed IfMatch into a 412, since it is the only precondition sent', async () => {
    send.mockRejectedValue(serviceException(412));

    await expect(
      getS3ObjectRange('uploads/a.pdf', { start: 0, end: 9 }, '"stale"'),
    ).rejects.toMatchObject({ statusCode: 412, code: 'REPRESENTATION_CHANGED' });
  });

  it('propagates anything else', async () => {
    send.mockRejectedValue(serviceException(500));

    await expect(
      getS3ObjectRange('uploads/a.pdf', { start: 0, end: 9 }, '"v1"'),
    ).rejects.not.toBeInstanceOf(AppError);
  });

  it('refuses a response whose body is not a Node stream', async () => {
    // Checked rather than cast: `Body` is the union of every runtime's stream
    // type, and an SDK that ever returns another one should fail here with a
    // message instead of at the first `pipeline()`.
    send.mockResolvedValue({ Body: 'not a stream' });

    await expect(
      getS3ObjectRange('uploads/a.pdf', { start: 0, end: 9 }, '"v1"'),
    ).rejects.toMatchObject({ statusCode: 502, code: 'STORAGE_BODY_MISSING' });
  });
});
