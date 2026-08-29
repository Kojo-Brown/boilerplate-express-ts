import type { Request, Response, NextFunction } from 'express';
import { sendByteRange } from '@/http/byte-range';
import type { ByteSource } from '@/http/byte-range';
import { AppError } from '@/lib/errors';
import { objectKeyFromId } from '@/upload/object-key';
import { getStorageProvider } from '@/upload/storage';
import type { DownloadParams } from '@/upload/upload.types';

/**
 * A stored object is immutable: its key contains a UUID minted at the moment
 * the bytes were written, and nothing in this service ever writes twice to the
 * same one. That is what makes a year-long `max-age` honest rather than
 * optimistic — the answer for a given key genuinely cannot change.
 *
 * `private`, because the route is behind `requireAuth` and a shared cache that
 * kept the response would serve one user's upload to the next caller who
 * guessed the URL.
 *
 * `immutable` is the part that pays: without it a browser revalidates on
 * reload, and a revalidation of a 4 GB video is a conditional request whose
 * whole purpose is to be answered 304 — cheap, but a round trip in front of
 * every seek.
 */
const DOWNLOAD_CACHE_CONTROL = 'private, max-age=31536000, immutable';

export const downloadController = {
  /**
   * `GET /v1/uploads/:objectId` — the stored bytes, whole or in part.
   *
   * Two calls to the backend, and the split is the design: `stat` first,
   * because a 304 and a 416 are both complete answers that must not transfer
   * anything, and only then a read of exactly the interval that survived. The
   * cost is one extra round trip to the object store on a request that does
   * transfer; the alternative — a single ranged GET, with the conditional
   * headers forwarded for the store to evaluate — cannot express `If-Range`,
   * whose failure mode is "ignore the range and send everything" rather than an
   * error, and would leave this API's cache semantics defined by the backend's.
   *
   * The `stat` is passed into `open` as `ifMatch`, so the two calls are pinned
   * to the same representation.
   */
  async download(
    req: Request<DownloadParams>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const key = objectKeyFromId(req.params.objectId);
      const provider = getStorageProvider();

      const stat = await provider.stat(key);
      if (stat === undefined) {
        next(new AppError(404, 'No object stored under that key', 'OBJECT_NOT_FOUND'));
        return;
      }

      const source: ByteSource = {
        size: stat.size,
        etag: stat.etag,
        contentType: stat.contentType,
        lastModified: stat.lastModified,
        open: (range) => provider.openRange(key, range, stat.etag),
      };

      await sendByteRange(req, res, source, { cacheControl: DOWNLOAD_CACHE_CONTROL });
    } catch (err) {
      next(err);
    }
  },
};
