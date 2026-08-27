import type { Request } from 'express';
import { AppError } from '@/lib/errors';
import { PayloadTooLargeError } from '@/streams/csv.errors';

/** The media types this service will read a CSV document from. */
export const CSV_MEDIA_TYPES = ['text/csv', 'application/csv', 'text/plain'] as const;

/**
 * Rejects a request whose body this service cannot read as CSV, before a byte
 * of it is consumed.
 *
 * Written as a plain function over `Request` rather than an Express middleware
 * so it can be used as a pipeline step and tested without a server — the same
 * shape every other step in `compose()` has.
 *
 * ## `Content-Encoding`
 *
 * The check that is easy to leave out and expensive to leave out. A client that
 * sends `Content-Encoding: gzip` is sending *compressed* bytes, and Node does
 * not decompress a request body for anybody: the parser would receive the gzip
 * container, fail to find a delimiter in it, and — because a gzip stream
 * contains no newlines to speak of — accumulate until it hit the record limit.
 * The client would then be told its CSV had an over-long record, which is true
 * and completely misleading. Answering 415 says the real thing.
 *
 * `text/plain` is accepted alongside the two CSV types because `curl --data-binary
 * @file` sends it and because a `.csv` served from a filesystem often is it. The
 * request is being told what it is by a header either way; the parser is what
 * decides whether it was true.
 *
 * ## `Content-Length`
 *
 * A fast path, never the enforcement. It is absent from every chunked request,
 * so a client can omit it and the only thing that bounds the upload is
 * `limitBytes` counting what actually arrives. Checking it anyway means an
 * honest client that declares 4 GB is refused without transferring 4 GB.
 */
export function requireCsvBody<TReq extends Request>(req: TReq, maxBytes: number): TReq {
  const encoding = req.get('content-encoding');
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
    throw new AppError(
      415,
      `Content-Encoding "${encoding}" is not supported; send the CSV uncompressed`,
      'UNSUPPORTED_CONTENT_ENCODING',
    );
  }

  // `req.is()` has three outcomes, not two, and the third is the one that bites:
  // `false` for a type that does not match, the matched type for one that does,
  // and `null` when the request declares no body at all — no `Content-Length`,
  // no `Transfer-Encoding`. Testing `!== false` therefore accepts a request with
  // no body and no content type, which reaches the parser as an empty document
  // and is reported as a successful import of nothing. Requiring a string is
  // what makes "said it was CSV" and "sent something" both necessary.
  if (!CSV_MEDIA_TYPES.some((type) => typeof req.is(type) === 'string')) {
    throw new AppError(
      415,
      `Expected a CSV body with one of: ${CSV_MEDIA_TYPES.join(', ')}`,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }

  const declared = req.get('content-length');
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new PayloadTooLargeError(maxBytes, length);
    }
  }

  return req;
}
