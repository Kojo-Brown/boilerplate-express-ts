import type { Response } from 'express';
import type { ApiMeta } from '@/lib/response';
import { ok } from '@/lib/response';
import { ETAG_HEADER, formatETag } from '@/concurrency/etag';

/**
 * Write a versioned row and the validator a client needs to write it back.
 *
 * Passed as `handle(operation, { send: sendWithETag })` rather than baked into
 * `toRequestHandler`. That option exists precisely so a route can own its
 * response line without every route paying for it, and an `ETag` is not a
 * property of enveloped responses in general — only of the ones whose body *is*
 * a single versioned resource. A collection has no one version, and a 204 has
 * no representation to tag.
 *
 * Handing out a tag matters as much as checking one. `If-Match` is required on
 * the writes, so a client with no way to learn the current version could only
 * ever send `*`, and the mechanism would degrade to an existence check.
 */
export function sendWithETag<TResult extends { version: number }>(
  res: Response,
  result: TResult,
  meta: ApiMeta | undefined,
): void {
  res.setHeader(ETAG_HEADER, formatETag(result.version));
  res.status(200).json(ok(result, meta));
}
