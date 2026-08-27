import type { Request } from 'express';
import { env } from '@/config/env';
import { USER_REPOSITORY } from '@/container/tokens';
import { scopeOf } from '@/middleware/container.middleware';
import { ingestCsv } from '@/ingest/csv-ingest';
import { requireCsvBody } from '@/ingest/csv-body';
import type { IngestSummary } from '@/ingest/ingest.types';
import type { RouteOperation } from '@/lib/route-decorators';
import type { Authenticated } from '@/lib/pipeline';
import {
  USER_IMPORT_BATCH_SIZE,
  USER_IMPORT_COLUMNS,
  userImportRowSchema,
  writeUserImportBatch,
} from '@/users/users-import';

/** A pipeline step, so the 415 is decided before the operation is entered. */
export function requireCsvUpload<TReq extends Request>(req: TReq): TReq {
  return requireCsvBody(req, env.USER_IMPORT_MAX_BYTES);
}

/**
 * `POST /v1/users/import` — streams a CSV of users into the table.
 *
 * ## Why this is not decorated
 *
 * Every other write in this service is wrapped in `withTimeout` and most reads
 * in `withRetry` and `withCache`. All three are wrong here and the reason is
 * the same in each case: the operation's input is a stream that can only be
 * read once.
 *
 * `withRetry` would re-invoke an operation whose `req` has already been
 * consumed and destroyed, so the second attempt reads zero bytes and reports a
 * successful import of nothing — a retry that converts a transient failure into
 * silent data loss. `withCache` would key a response on a URL that says nothing
 * about the body. And `withTimeout` is a deadline on a request whose legitimate
 * duration is a function of how much the client chose to send; any constant is
 * either too short for a large file or useless for a small one. What bounds
 * this request instead is `USER_IMPORT_MAX_BYTES` — a bound on the work rather
 * than on the clock.
 *
 * ## Why the answer is one JSON body at the end
 *
 * A streamed response — NDJSON progress per batch — is the tempting shape and
 * it costs the status code. The head goes out with the first byte, so a header
 * that turns out to be unbindable at record one can no longer be a 400; it
 * becomes a 200 whose body says something went wrong, which every generated
 * client in existence will read as success. Answering once at the end keeps the
 * status honest, and the summary is bounded — counts plus a capped error list —
 * so "buffer the response" does not mean buffering the upload.
 *
 * The consequence, stated plainly: a client learns nothing until the import
 * finishes, and a partial write is invisible until then. `written` is what
 * makes it recoverable, and `ON CONFLICT DO NOTHING` is what makes re-uploading
 * the whole file the correct response to any failure.
 */
export const importUsers: RouteOperation<IngestSummary, Authenticated<Request>> = async (req) => {
  const repository = scopeOf(req).resolve(USER_REPOSITORY);

  return ingestCsv({
    // `req` itself, not a buffered copy. Express's body parsers decline a
    // `text/csv` body — `express.json()` matches on content type — which is
    // exactly what leaves the stream unread and available here.
    source: req,
    columns: USER_IMPORT_COLUMNS,
    schema: userImportRowSchema,
    batchSize: USER_IMPORT_BATCH_SIZE,
    maxBytes: env.USER_IMPORT_MAX_BYTES,
    maxReportedErrors: env.USER_IMPORT_MAX_REPORTED_ERRORS,
    write: (batch) => writeUserImportBatch(repository, batch),
  });
};
