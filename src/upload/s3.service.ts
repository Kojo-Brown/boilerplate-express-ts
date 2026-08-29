import { Readable } from 'node:stream';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { buildObjectKey } from '@/upload/object-key';
import type { ObjectRange, ObjectStat } from '@/upload/storage/storage.types';

let _s3: S3Client | null = null;

function getS3(): S3Client {
  if (_s3 === null) {
    _s3 = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

export function buildPublicUrl(key: string): string {
  return `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

export async function generatePresignedPutUrl(
  fileName: string,
  contentType: string,
): Promise<{ presignedUrl: string; key: string; expiresIn: number }> {
  const key = buildObjectKey(fileName);
  const expiresIn = env.S3_PRESIGNED_EXPIRES_IN;

  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const presignedUrl = await getSignedUrl(getS3(), command, { expiresIn });
  return { presignedUrl, key, expiresIn };
}

export async function uploadToS3(
  buffer: Buffer,
  originalName: string,
  contentType: string,
): Promise<{ key: string; url: string }> {
  const key = buildObjectKey(originalName);

  await getS3().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );

  return { key, url: buildPublicUrl(key) };
}

/**
 * `HeadObject`: everything a conditional or ranged GET needs, and no bytes.
 *
 * Returns `undefined` for an object that is not there. S3 answers a HEAD on a
 * missing key with a bare 404 carrying no error code — the SDK surfaces it as
 * `NotFound` rather than the `NoSuchKey` a GET produces — so both are treated
 * as the same absence here, which is also what makes this correct against
 * S3-compatible stores that pick the other one.
 */
export async function headS3Object(key: string): Promise<ObjectStat | undefined> {
  let response;
  try {
    response = await getS3().send(
      new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    );
  } catch (err) {
    if (err instanceof NotFound || err instanceof NoSuchKey) return undefined;
    throw err;
  }

  const { ContentLength, ETag, ContentType, LastModified } = response;

  // Every one of these is optional in the model and present in practice. A
  // response missing `ContentLength` or `ETag` cannot be served as a range
  // request at all — the arithmetic and the `If-Range` comparison are both
  // built out of them — so this fails loudly rather than inventing a zero.
  if (ContentLength === undefined || ETag === undefined) {
    throw new AppError(
      502,
      'Object store returned no length or entity-tag',
      'STORAGE_METADATA_MISSING',
    );
  }

  return {
    key,
    size: ContentLength,
    // S3's `ETag` arrives already quoted, and is a strong validator: it changes
    // with the bytes (an MD5 for a single-part upload, an opaque digest-of-
    // digests for a multipart one). It is passed through untouched — re-quoting
    // it would produce a tag that matches nothing a previous response handed
    // out.
    etag: ETag,
    contentType: ContentType ?? 'application/octet-stream',
    lastModified: LastModified ?? new Date(0),
  };
}

/**
 * `GetObject` over an inclusive byte interval, as a stream.
 *
 * The `Range` goes to S3 rather than being applied here: asking for the whole
 * object and discarding all but a slice would pay for the entire transfer to
 * serve 200 KB of it, which is the exact cost this endpoint exists to avoid.
 *
 * `IfMatch` makes the read fail rather than return the wrong bytes if the
 * object was replaced since the `HeadObject` — see `StorageProvider.openRange`.
 */
export async function getS3ObjectRange(
  key: string,
  range: ObjectRange,
  ifMatch: string,
): Promise<Readable> {
  let response;
  try {
    response = await getS3().send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Range: `bytes=${range.start}-${range.end}`,
        IfMatch: ifMatch,
      }),
    );
  } catch (err) {
    if (err instanceof NoSuchKey || err instanceof NotFound) {
      throw new AppError(404, 'No object stored under that key', 'OBJECT_NOT_FOUND');
    }
    // There is no exported `PreconditionFailed` for `GetObject`, so the status
    // is what identifies it. 412 here means only one thing: `IfMatch` did not
    // hold, because it is the sole precondition this request carries.
    if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 412) {
      throw new AppError(412, 'The object changed while being read', 'REPRESENTATION_CHANGED');
    }
    throw err;
  }

  // `Body` is typed as the union of every runtime's stream, and only the Node
  // one is a `Readable`. Checking rather than casting means an SDK that ever
  // hands back something else fails here, with a message, instead of at the
  // first `pipeline()` with a type error the compiler was told to ignore.
  if (!(response.Body instanceof Readable)) {
    throw new AppError(502, 'Object store returned no readable body', 'STORAGE_BODY_MISSING');
  }

  return response.Body;
}
