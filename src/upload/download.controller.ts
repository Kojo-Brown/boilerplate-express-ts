import type { Request, Response, NextFunction } from 'express';
import { isMediaType, selectMediaType } from '@/http/accept';
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

      // Proactive negotiation (RFC 9110 §12.5.1), after the 404 and before the
      // read. After, because the stored media type is the only representation
      // on offer, so there is nothing to negotiate about a key holding nothing
      // — and a 406 there would answer differently for a key that exists than
      // for one that does not, to a caller whose `Accept` matches neither.
      // Before, because a 406 transfers no bytes and so must not cost a request
      // to the object store.
      //
      // One offer, and never a list: this service stores what it was given and
      // cannot transcode, so the choice is take-it-or-nothing. That is also why
      // a 406 here is honest rather than lazy — on a route that renders its own
      // body, a 406 is a decision not to build a representation.
      //
      // `isMediaType` guards the call because the stored type is *data*: it was
      // decided at upload time, and a label this parser cannot read is a
      // labelling problem rather than a negotiation one. Without the guard an
      // object stored under a malformed `Content-Type` would be offered as
      // nothing, refused as a 406, and unreachable for good — the response
      // would still have carried that exact label if the client had sent no
      // `Accept` at all.
      if (
        isMediaType(stat.contentType) &&
        selectMediaType(req.headers['accept'], [stat.contentType]) === null
      ) {
        next(
          new AppError(
            406,
            // §15.5.7 asks a 406 to say what is available. The only consumer
            // that can act on it is a person reading the message, so the stored
            // type goes in the message rather than into a machine-readable list
            // this API has no format for.
            `The stored object is ${stat.contentType}, which this request does not accept`,
            'NOT_ACCEPTABLE',
          ),
        );
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
