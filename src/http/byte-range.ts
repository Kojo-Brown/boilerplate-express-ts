import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { evaluateReadPreconditions, shouldApplyRange } from '@/http/conditional';
import {
  formatContentRange,
  formatUnsatisfiedRange,
  parseRangeHeader,
  rangeLength,
  resolveRange,
} from '@/http/range';
import type { ByteRange } from '@/http/range';
import { sendFail } from '@/lib/response';

/**
 * A representation that can be served a slice at a time.
 *
 * Deliberately not "a file" and not "an S3 object": everything specific to
 * where the bytes are lives behind `open`, so this module has one code path for
 * a 40 GB object in S3 and for a fixture in a `Map`, and a test can drive the
 * whole HTTP contract without a storage backend at all.
 *
 * `size` is the length of the *whole* representation and is what every
 * `Content-Range` is denominated in. It has to be known before the first byte
 * is sent — a range response is arithmetic on it — which is the real reason
 * this interface exists rather than the handler being handed a stream.
 */
export interface ByteSource {
  /** Total length in bytes. */
  readonly size: number;
  /** The `ETag` field value, quotes included, exactly as it goes on the wire. */
  readonly etag: string;
  readonly contentType: string;
  readonly lastModified?: Date;
  /**
   * Opens a stream over an inclusive byte interval.
   *
   * Called at most once per request, and never for a response with no body, so
   * an implementation is free to make it a network request. It must yield
   * exactly `end - start + 1` bytes: the `Content-Length` has already been
   * committed to by the time this runs, and a stream that is short leaves the
   * client waiting on a response the server thinks it finished.
   */
  open(range: ByteRange): Promise<Readable>;
}

export interface SendByteRangeOptions {
  /**
   * `Cache-Control` for a 200/206/304.
   *
   * Defaulted rather than omitted because the absence of the header is itself a
   * caching policy — a heuristically cacheable one — and "whatever the
   * intermediary guesses" is not a thing to ship for a route behind auth.
   */
  readonly cacheControl?: string;
}

/**
 * Conservative by default: a shared cache must not keep a response that was
 * only authorised for one caller, and revalidation is cheap here because the
 * validators are exact.
 */
const DEFAULT_CACHE_CONTROL = 'private, no-cache';

/**
 * Answers a GET or HEAD for a possibly-partial representation.
 *
 * The whole of RFC 9110's read path in the order the RFC evaluates it:
 * `If-None-Match`/`If-Modified-Since` first (a 304 costs nothing and must not
 * be turned into a 206 by a `Range` further down the request), then `If-Range`
 * deciding whether the `Range` counts at all, then the range itself.
 *
 * ## Errors after the first byte
 *
 * Once a byte of the body is out, the status line is spent: there is no way to
 * turn a half-sent 200 into a 500, and calling `next(err)` would have the error
 * middleware try to write a second set of headers onto a response that already
 * has some. The connection is destroyed instead, which is the only signal left
 * that the body is truncated — a client that has a `Content-Length` sees the
 * transfer end short and knows. So this function throws only while the head is
 * still unwritten, and the caller can rely on that.
 */
export async function sendByteRange(
  req: Request,
  res: Response,
  source: ByteSource,
  options: SendByteRangeOptions = {},
): Promise<void> {
  const validators = {
    etag: source.etag,
    ...(source.lastModified !== undefined ? { lastModified: source.lastModified } : {}),
  };

  // `Accept-Ranges` on every response, including the 304 and the 416: it is how
  // a client learns that resuming is possible at all, and a client that only
  // ever gets 304s would otherwise never find out.
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', source.etag);
  res.setHeader('Cache-Control', options.cacheControl ?? DEFAULT_CACHE_CONTROL);
  if (source.lastModified !== undefined) {
    res.setHeader('Last-Modified', source.lastModified.toUTCString());
  }

  const precondition = evaluateReadPreconditions(
    {
      ifNoneMatch: headerValue(req, 'if-none-match'),
      ifModifiedSince: headerValue(req, 'if-modified-since'),
    },
    validators,
  );

  if (precondition === 'not-modified') {
    // No `Content-Type` and no `Content-Length`: a 304 carries no content, and
    // a `Content-Length` describing content that is not there is exactly the
    // framing error that hangs a connection.
    res.status(304).end();
    return;
  }

  const resolution = resolveRequestedRange(req, source.size, validators);

  if (resolution.kind === 'unsatisfiable') {
    // Before the body, because `sendFail` writes the head.
    res.setHeader('Content-Range', formatUnsatisfiedRange(source.size));
    sendFail(
      res,
      416,
      'RANGE_NOT_SATISFIABLE',
      `The requested range cannot be satisfied by a ${source.size}-byte representation`,
    );
    return;
  }

  const partial = resolution.kind === 'range';
  const range: ByteRange = partial
    ? resolution.range
    : // An empty representation has no last byte, so the "whole thing" is an
      // interval that names nothing. It is never opened — see below — and the
      // length arithmetic still comes out at zero.
      { start: 0, end: source.size - 1 };
  const length = partial ? rangeLength(range) : source.size;

  const commitHead = (): void => {
    res.status(partial ? 206 : 200);
    res.setHeader('Content-Type', source.contentType);
    res.setHeader('Content-Length', String(length));
    if (partial) {
      res.setHeader('Content-Range', formatContentRange(range, source.size));
    }
  };

  // A HEAD answers with the headers its GET would have produced and no content
  // — including the 206 and its `Content-Range`, which is how a client sizes a
  // download before starting one. Node would drop a body written here anyway;
  // returning early also means never opening the source, so a HEAD costs no
  // read at the storage backend.
  if (req.method === 'HEAD' || length === 0) {
    commitHead();
    res.end();
    return;
  }

  // Opened *before* the head is committed, and that ordering is the whole
  // reason this is a closure. A failing `open` is a perfectly ordinary
  // outcome — the object was deleted between the `stat` and here, the backend
  // is unreachable — and it has to be able to become a 503 or a 404. Setting
  // `Content-Type: video/mp4` and a `Content-Length` of four gigabytes first
  // leaves both on the error response the handler writes instead, so the client
  // gets a JSON body framed as a truncated video.
  const stream = await source.open(range);
  commitHead();

  try {
    // `pipeline`, never `stream.pipe(res)`: on a client disconnect `pipe` leaves
    // the source running, which for a 40 GB object means this process goes on
    // paying S3 for a transfer whose recipient hung up. `pipeline` destroys the
    // source, and destroying the source is what aborts the underlying request.
    await pipeline(stream, res);
  } catch (err) {
    if (isPrematureClose(err)) return;
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : undefined);
      return;
    }
    throw err;
  }
}

function resolveRequestedRange(
  req: Request,
  size: number,
  validators: { etag: string; lastModified?: Date },
): ReturnType<typeof resolveRange> {
  const header = headerValue(req, 'range');
  if (header === undefined) return { kind: 'ignore' };

  // RFC 9110 §14.2: `Range` is defined for GET (and, by extension, the HEAD
  // that previews one). On anything else it has no meaning and is ignored,
  // rather than being allowed to turn a write into a partial anything.
  if (req.method !== 'GET' && req.method !== 'HEAD') return { kind: 'ignore' };

  if (!shouldApplyRange(headerValue(req, 'if-range'), validators)) return { kind: 'ignore' };

  const specs = parseRangeHeader(header);
  if (specs === null) return { kind: 'ignore' };

  return resolveRange(specs, size);
}

/**
 * One header value, or `undefined`.
 *
 * Node folds repeats of most fields into a comma-joined string, which is what
 * the list grammars already expect; the array form only shows up for
 * `set-cookie`. Taking the first element rather than joining is still the
 * right call for the one field here that is not a list — a repeated `If-Range`
 * is a malformed request, and joining would build a value that parses as
 * neither a tag nor a date, which is how it should be treated anyway.
 */
function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The client went away mid-transfer.
 *
 * Ordinary, not exceptional: it is what a paused video, a cancelled download
 * and a closed tab all look like from here. Logging it as an error would fill
 * the logs of any service that streams with its own healthy traffic.
 */
function isPrematureClose(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}
