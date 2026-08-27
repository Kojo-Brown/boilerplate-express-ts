import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { ZodType, ZodTypeDef } from 'zod';
import { CsvParser } from '@/streams/csv-parser';
import { batchObjects } from '@/streams/batch';
import { limitBytes } from '@/streams/byte-limit';
import { createAsyncSink } from '@/streams/async-sink';
import type { ColumnSpec } from '@/ingest/header';
import { RowErrorSink } from '@/ingest/ingest.types';
import type { IngestSummary } from '@/ingest/ingest.types';
import { createRecordMapper } from '@/ingest/record-mapper';

export interface CsvIngestOptions<T> {
  /** The bytes. In a route this is `req`; in a test it is anything readable. */
  readonly source: Readable;
  readonly columns: readonly ColumnSpec[];
  readonly schema: ZodType<T, ZodTypeDef, unknown>;
  /**
   * Writes one batch and reports how many rows it actually created.
   *
   * Async by contract, because this is the only place in the chain that is
   * allowed to be slow — everything upstream is throttled by how long this
   * takes to resolve.
   */
  readonly write: (batch: readonly T[]) => Promise<number>;
  readonly batchSize: number;
  readonly maxBytes: number;
  readonly maxRecordChars?: number;
  readonly maxReportedErrors?: number;
  readonly delimiter?: string;
}

/**
 * Reads a CSV document off a stream, validates it row by row, and writes it in
 * batches — at a fixed, small memory cost regardless of how large the document
 * is.
 *
 * ```
 *   source ─▶ limitBytes ─▶ CsvParser ─▶ recordMapper ─▶ batchObjects ─▶ sink
 *   bytes      bytes         records      rows            batches        awaits
 * ```
 *
 * ## Why `pipeline()` and not `.pipe()`
 *
 * Three reasons, and each one is a production incident that `.pipe()` does not
 * prevent.
 *
 * `.pipe()` does not forward errors. An `error` on the parser leaves the sink
 * with no idea anything happened, so the write side simply never ends: the
 * request hangs until a proxy times it out, and the only trace is a socket that
 * closed. `pipeline()` propagates the first error and rejects with it.
 *
 * `.pipe()` does not destroy the rest of the chain. When the sink fails — the
 * database went away mid-import — the source is still flowing, still being read
 * off the socket, and still buffering into a stream nobody will ever drain. The
 * classic form of this leak is a request that errored ten seconds ago and is
 * still consuming bandwidth. `pipeline()` calls `destroy()` on every stream it
 * was given.
 *
 * And `pipeline()` cleans up on *premature* close, which is the ordinary case
 * here rather than an exotic one: a client that hangs up halfway through an
 * upload destroys `req`, and every stream downstream has to be torn down with
 * it. That arrives as `ERR_STREAM_PREMATURE_CLOSE` and it is a real outcome of
 * this function, not a bug — see `docs/csv-ingest.md`.
 *
 * ## What is guaranteed, and what is not
 *
 * Guaranteed: memory is bounded by the batch size and the per-stage
 * `highWaterMark`s, not by the size of the upload; the socket is not read
 * faster than the database can absorb; and the byte limit is enforced against
 * the bytes that actually arrive rather than against a header the client
 * controls.
 *
 * Not guaranteed: atomicity. Each batch is written independently, so an ingest
 * that fails at row 40,000 leaves the first 39,500 rows written. That is a
 * deliberate trade against the alternative — one transaction spanning the whole
 * upload — which would hold a pooled connection and pin the cluster's `xmin`
 * horizon for the length of an arbitrarily long HTTP request, stalling
 * autovacuum database-wide because somebody is on hotel wifi. The cost is paid
 * back by making `write` idempotent per row, which is what lets a failed import
 * be resumed by simply re-uploading the same file.
 */
export async function ingestCsv<T>(options: CsvIngestOptions<T>): Promise<IngestSummary> {
  const sink = new RowErrorSink(options.maxReportedErrors ?? 100);
  let recordsRead = 0;
  let accepted = 0;
  let written = 0;

  await pipeline(
    options.source,
    limitBytes(options.maxBytes),
    new CsvParser({
      ...(options.maxRecordChars === undefined ? {} : { maxRecordChars: options.maxRecordChars }),
      ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
    }),
    createRecordMapper<T>({
      columns: options.columns,
      schema: options.schema,
      sink,
      onRecord: () => {
        recordsRead += 1;
      },
    }),
    batchObjects<T>(options.batchSize),
    createAsyncSink<readonly T[]>(async (batch) => {
      accepted += batch.length;
      written += await options.write(batch);
    }),
  );

  return {
    recordsRead,
    accepted,
    written,
    rejected: sink.rejected,
    errors: sink.errors,
    errorsTruncated: sink.truncated,
  };
}
