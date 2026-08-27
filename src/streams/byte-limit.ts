import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { PayloadTooLargeError } from '@/streams/csv.errors';

/**
 * Passes bytes through and fails the stream once `maxBytes` have gone by.
 *
 * ## Why the route cannot just trust `Content-Length`
 *
 * Because it is optional. A `Transfer-Encoding: chunked` request has no
 * `Content-Length` at all, which is exactly the shape a client streaming a
 * large export produces — and a client that wanted to hurt this endpoint would
 * send one deliberately. Checking the header is still worth doing, because it
 * rejects an oversized upload before a single byte of it is read; but it is a
 * fast path in front of this, never a replacement for it.
 *
 * ## Why this is not `express.json`'s problem
 *
 * `express.json()` and `express.urlencoded()` each carry a `limit` and each
 * declines to act on a `text/csv` body, which is precisely what makes the raw
 * stream available to this route — and precisely what leaves it unbounded. The
 * limit that a body parser would have applied has to be reapplied by whoever
 * reads the body instead of one.
 *
 * The error is raised as soon as the boundary is crossed rather than at end of
 * stream, so the connection is torn down mid-upload instead of after the
 * remaining gigabyte has been read and discarded.
 */
export function limitBytes(maxBytes: number): Transform {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(
      `limitBytes: maxBytes must be a positive integer, received ${String(maxBytes)}`,
    );
  }

  let seen = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new PayloadTooLargeError(maxBytes, seen));
        return;
      }
      callback(null, chunk);
    },
  });
}
