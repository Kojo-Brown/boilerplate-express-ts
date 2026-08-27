import type { ErrorTranslator } from '@/lib/error-translators';

/**
 * The reasons this parser refuses to keep going.
 *
 * All four are statements about the *document* rather than about a row: a
 * record that will not terminate, a quote that will not close, a quote in a
 * position where the grammar has no meaning for it. Nothing here is a bad email
 * address — a row that parses into fields and then fails validation is data,
 * collected and reported per row, and does not stop the ingest. That split is
 * the whole reason this is a distinct error type: one class aborts the upload
 * with a 400, the other accumulates into the summary.
 */
export const CSV_PARSE_ERROR_CODES = [
  'CSV_RECORD_TOO_LARGE',
  'CSV_UNTERMINATED_QUOTE',
  'CSV_INVALID_QUOTE',
  'CSV_HEADER_INVALID',
] as const;

export type CsvParseErrorCode = (typeof CSV_PARSE_ERROR_CODES)[number];

/**
 * A malformed CSV document.
 *
 * Deliberately not an `AppError`. `csv-parser.ts` is a stream transform that
 * knows nothing about HTTP and is useful from a CLI or a worker; giving it a
 * status code would put an Express concept inside a `node:stream` module and
 * would make the parser's tests assert on numbers that mean nothing there. The
 * mapping to 400 lives in `csvErrorTranslator` below, registered in the
 * composition root exactly like the Postgres and Multer translators — which is
 * also what makes the 400 arrive from a route that never catches this.
 */
export class CsvParseError extends Error {
  constructor(
    readonly code: CsvParseErrorCode,
    message: string,
    /** 1-based line the parser was on when it gave up. */
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvParseError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * A payload that exceeded the byte budget for the endpoint.
 *
 * Separate from `CsvParseError` because it is not a claim about the document:
 * the bytes seen so far may be perfectly well-formed CSV. It is 413 and it is
 * the only thing standing between this endpoint and an unbounded upload —
 * `express.json()` has a `limit`, and a route that reads `req` as a raw stream
 * has nothing at all unless it counts.
 */
export class PayloadTooLargeError extends Error {
  constructor(
    readonly limitBytes: number,
    readonly receivedBytes: number,
  ) {
    super(`Request body exceeded the ${String(limitBytes)} byte limit`);
    this.name = 'PayloadTooLargeError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * A malformed document is the client's mistake, so it is a 400 and the message
 * says which line to look at — the one thing that makes a 30,000-row file
 * fixable. Untranslated, both of these would surface as 500s and a client
 * uploading a truncated file would have every reason to retry it forever.
 */
export const csvErrorTranslator: ErrorTranslator = (err) => {
  if (err instanceof CsvParseError) {
    return { statusCode: 400, code: err.code, message: `${err.message} (line ${String(err.line)})` };
  }
  if (err instanceof PayloadTooLargeError) {
    return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: err.message };
  }
  return null;
};
