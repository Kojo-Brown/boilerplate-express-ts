import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { env } from '@/config/env';

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

function buildObjectKey(originalName: string): string {
  const lastDot = originalName.lastIndexOf('.');
  const ext = lastDot !== -1 ? originalName.slice(lastDot) : '';
  return `uploads/${randomUUID()}${ext}`;
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
