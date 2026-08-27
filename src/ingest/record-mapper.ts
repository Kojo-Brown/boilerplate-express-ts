import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import type { ZodType, ZodTypeDef } from 'zod';
import type { CsvRecord } from '@/streams/csv-parser';
import { bindHeader } from '@/ingest/header';
import type { ColumnSpec, HeaderBinding } from '@/ingest/header';
import type { RowErrorSink } from '@/ingest/ingest.types';

export interface RecordMapperOptions<T> {
  readonly columns: readonly ColumnSpec[];
  /** Validates and shapes one row's raw string fields. */
  readonly schema: ZodType<T, ZodTypeDef, unknown>;
  /** Where rejected rows go. Rejections do not stop the stream. */
  readonly sink: RowErrorSink;
  /** Called once per data record, whether it validates or not. */
  readonly onRecord?: () => void;
  readonly highWaterMark?: number;
}

/**
 * Records in, validated rows out; rejections diverted to the sink.
 *
 * ## Why rejections leave through a side channel
 *
 * The alternative is emitting a discriminated union and filtering downstream,
 * and it does not survive the next stage: the batcher would then group a
 * mixture of rows and failures into arrays the database sink has to re-partition,
 * and every consumer of the stream would carry a branch for a case it has
 * nothing to do about. Keeping the stream single-typed means the sink's type
 * says what it writes.
 *
 * ## Why a bad row does not stop the import
 *
 * Because the client cannot fix what it cannot see. Aborting on the first
 * malformed address turns a 30,000-row upload into 30,000 round trips to
 * discover 12 bad rows one at a time. A structurally broken *document* is a
 * different matter and still aborts — see `bindHeader` and `CsvParser` — because
 * there the rest of the file cannot be read at all.
 */
export function createRecordMapper<T>(options: RecordMapperOptions<T>): Transform {
  const { columns, schema, sink, onRecord } = options;
  let binding: HeaderBinding | null = null;
  let headerWidth = 0;

  return new Transform({
    objectMode: true,
    readableHighWaterMark: options.highWaterMark ?? 1,
    writableHighWaterMark: options.highWaterMark ?? 1,

    transform(record: CsvRecord, _encoding: BufferEncoding, callback: TransformCallback): void {
      if (binding === null) {
        try {
          binding = bindHeader(record, columns);
          headerWidth = record.fields.length;
        } catch (err) {
          callback(err as Error);
          return;
        }
        callback();
        return;
      }

      onRecord?.();

      // A ragged row is a row-level fault, not a document-level one: the file is
      // still parseable and every other row still means what it says. Checked
      // before the fields are read, because a short row would otherwise bind a
      // column to `undefined` and be reported as "email is required" — true, and
      // useless for finding the stray delimiter that actually caused it.
      if (record.fields.length !== headerWidth) {
        sink.record({
          line: record.line,
          message: `Expected ${String(headerWidth)} fields to match the header, found ${String(record.fields.length)}`,
        });
        callback();
        return;
      }

      const raw: Record<string, string> = {};
      for (const [name, index] of binding) {
        raw[name] = record.fields[index] ?? '';
      }

      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const column = issue.path[0];
          sink.record({
            line: record.line,
            ...(typeof column === 'string' ? { column } : {}),
            message: issue.message,
          });
        }
        callback();
        return;
      }

      callback(null, parsed.data);
    },
  });
}
