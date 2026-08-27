import { Readable } from 'node:stream';
import { z } from 'zod';
import { ingestCsv } from '@/ingest/csv-ingest';
import type { ColumnSpec } from '@/ingest/header';
import { CsvParseError, PayloadTooLargeError } from '@/streams/csv.errors';

const COLUMNS: readonly ColumnSpec[] = [
  { name: 'email', required: true },
  { name: 'age', required: false },
];

const rowSchema = z.object({
  email: z.string().trim().min(1, 'email is required').email('email must be a valid address'),
  age: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : Number(value)))
    .refine((value) => value === undefined || Number.isFinite(value), 'age must be a number'),
});

type Row = z.infer<typeof rowSchema>;

interface Harness {
  readonly batches: Row[][];
  readonly write: (batch: readonly Row[]) => Promise<number>;
}

function recordingSink(perBatchDelayMs = 0, writtenPerRow = 1): Harness {
  const batches: Row[][] = [];
  return {
    batches,
    write: async (batch) => {
      if (perBatchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, perBatchDelayMs));
      }
      batches.push([...batch]);
      return batch.length * writtenPerRow;
    },
  };
}

const defaults = { columns: COLUMNS, schema: rowSchema, batchSize: 2, maxBytes: 1024 * 1024 };

describe('ingestCsv', () => {
  it('parses, validates and writes every row in batches', async () => {
    const sink = recordingSink();
    const summary = await ingestCsv<Row>({
      ...defaults,
      source: Readable.from(['email,age\na@x.test,30\nb@x.test,41\nc@x.test,\n']),
      write: sink.write,
    });

    expect(summary).toMatchObject({
      recordsRead: 3,
      accepted: 3,
      written: 3,
      rejected: 0,
      errors: [],
      errorsTruncated: false,
    });
    expect(sink.batches).toEqual([
      [
        { email: 'a@x.test', age: 30 },
        { email: 'b@x.test', age: 41 },
      ],
      [{ email: 'c@x.test', age: undefined }],
    ]);
  });

  it('reports written separately from accepted when the sink deduplicates', async () => {
    // The gap that makes "I uploaded 4 and it says 4" readable: the sink here
    // writes nothing at all, and the summary says so.
    const summary = await ingestCsv<Row>({
      ...defaults,
      source: Readable.from(['email\na@x.test\nb@x.test\n']),
      write: () => Promise.resolve(0),
    });

    expect(summary.accepted).toBe(2);
    expect(summary.written).toBe(0);
  });

  it('collects row-level failures without stopping the import', async () => {
    const sink = recordingSink();
    const summary = await ingestCsv<Row>({
      ...defaults,
      source: Readable.from(['email,age\na@x.test,1\nnot-an-email,2\nc@x.test,3\n']),
      write: sink.write,
    });

    expect(summary.recordsRead).toBe(3);
    expect(summary.rejected).toBe(1);
    expect(summary.written).toBe(2);
    expect(summary.errors).toEqual([
      { line: 3, column: 'email', message: 'email must be a valid address' },
    ]);
    expect(sink.batches.flat().map((row) => row.email)).toEqual(['a@x.test', 'c@x.test']);
  });

  it('reports a ragged row as a field-count mismatch rather than as a missing value', async () => {
    const summary = await ingestCsv<Row>({
      ...defaults,
      source: Readable.from(['email,age\na@x.test\n']),
      write: () => Promise.resolve(0),
    });

    expect(summary.rejected).toBe(1);
    expect(summary.errors[0]?.message).toContain('Expected 2 fields');
  });

  it('caps the reported errors while keeping the count exact', async () => {
    const bad = Array.from({ length: 25 }, (_, i) => `bad-${String(i)}`).join('\n');
    const summary = await ingestCsv<Row>({
      ...defaults,
      source: Readable.from([`email\n${bad}\n`]),
      write: () => Promise.resolve(0),
      maxReportedErrors: 5,
    });

    expect(summary.rejected).toBe(25);
    expect(summary.errors).toHaveLength(5);
    expect(summary.errorsTruncated).toBe(true);
  });

  it('reads a quoted field containing the delimiter, which is how a list column arrives', async () => {
    const listSchema = z.object({
      email: z.string().email(),
      age: z.string().optional(),
    });
    const summary = await ingestCsv<z.infer<typeof listSchema>>({
      ...defaults,
      schema: listSchema,
      source: Readable.from(['email,age\na@x.test,"30,31"\n']),
      write: (batch) => {
        expect(batch[0]?.age).toBe('30,31');
        return Promise.resolve(batch.length);
      },
    });
    expect(summary.written).toBe(1);
  });

  describe('document-level failures abort the whole upload', () => {
    it('rejects an unrecognised header column', async () => {
      await expect(
        ingestCsv<Row>({
          ...defaults,
          source: Readable.from(['email,nickname\na@x.test,al\n']),
          write: () => Promise.resolve(0),
        }),
      ).rejects.toMatchObject({ code: 'CSV_HEADER_INVALID' });
    });

    it('rejects a header missing a required column', async () => {
      await expect(
        ingestCsv<Row>({
          ...defaults,
          source: Readable.from(['age\n30\n']),
          write: () => Promise.resolve(0),
        }),
      ).rejects.toBeInstanceOf(CsvParseError);
    });

    it('rejects a body over the byte limit', async () => {
      const big = `email\n${'a@x.test\n'.repeat(500)}`;
      await expect(
        ingestCsv<Row>({
          ...defaults,
          maxBytes: 64,
          source: Readable.from([big]),
          write: () => Promise.resolve(0),
        }),
      ).rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('propagates a sink failure and destroys the source', async () => {
      const source = Readable.from(['email\na@x.test\nb@x.test\n']);
      await expect(
        ingestCsv<Row>({
          ...defaults,
          batchSize: 1,
          source,
          write: () => Promise.reject(new Error('connection terminated')),
        }),
      ).rejects.toThrow('connection terminated');
      expect(source.destroyed).toBe(true);
    });

    it('surfaces a client hanging up mid-upload as a premature close', async () => {
      const source = new Readable({
        read() {
          this.push('email\na@x.test\n');
          // What a destroyed request socket looks like from here.
          this.destroy();
        },
      });

      await expect(
        ingestCsv<Row>({ ...defaults, source, write: () => Promise.resolve(1) }),
      ).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
    });
  });

  describe('back-pressure', () => {
    /**
     * The claim this whole item rests on: the bytes are not read faster than
     * the sink can absorb them.
     *
     * Measured with counters rather than clocks, so it does not depend on how
     * loaded the machine is. The source records how many bytes it has been
     * asked for; the sink records that number at the start of every batch
     * write. If nothing were pushing back, the source would be drained into
     * buffers long before the first slow write finished and every reading would
     * be the whole document.
     */
    function measuredSource(rows: number, chunkRows: number): { stream: Readable; read: () => number } {
      const lines: string[] = ['email,age\n'];
      for (let i = 0; i < rows; i += 1) lines.push(`user-${String(i)}@x.test,${String(i % 90)}\n`);

      const chunks: Buffer[] = [];
      for (let i = 0; i < lines.length; i += chunkRows) {
        chunks.push(Buffer.from(lines.slice(i, i + chunkRows).join(''), 'utf8'));
      }

      let bytesRead = 0;
      let index = 0;
      const stream = new Readable({
        read() {
          const chunk = chunks[index];
          index += 1;
          if (chunk === undefined) {
            this.push(null);
            return;
          }
          bytesRead += chunk.length;
          this.push(chunk);
        },
      });

      return { stream, read: () => bytesRead };
    }

    /**
     * Runs an ingest and reports the most the source advanced *during* a single
     * sink write — the sharpest available reading of whether anything is
     * actually being held back.
     *
     * Measuring how much had been read when the first write *began* is the
     * obvious thing to do and it is not enough: that number is small either
     * way, because the first batch is assembled from the first few chunks
     * whether or not anybody throttles what comes after. What separates the two
     * worlds is what happens while the sink is awaiting — under back-pressure
     * the source is stalled and advances by at most the chain's fixed buffers,
     * and without it the entire remaining document is read into memory during
     * that one pause.
     */
    async function maxAdvanceDuringWrite(
      rows: number,
      batchSize: number,
    ): Promise<{ maxAdvance: number; totalBytes: number; written: number }> {
      const { stream, read } = measuredSource(rows, 50);
      let maxAdvance = 0;

      const summary = await ingestCsv<Row>({
        ...defaults,
        // Above the largest document here: this measures buffering, and a 413
        // partway through would measure the limiter instead.
        maxBytes: 64 * 1024 * 1024,
        batchSize,
        source: stream,
        write: async (batch) => {
          const before = read();
          await new Promise((resolve) => setTimeout(resolve, 2));
          maxAdvance = Math.max(maxAdvance, read() - before);
          return batch.length;
        },
      });

      return { maxAdvance, totalBytes: read(), written: summary.written };
    }

    /**
     * The ceiling the chain settles at, measured rather than derived.
     *
     * Every stage's buffer is a constant — the source's own, the byte limiter's
     * two 16 KiB sides, a record in the parser, a row in the mapper, a batch
     * either side of the batcher, one in flight at the sink — so their sum is a
     * constant too, and on this configuration it comes out at about 272 KiB.
     * Deriving that number from the parts would be guesswork about how Node
     * schedules the refills between them; what the tests below actually assert
     * is the property that matters, which is that it *plateaus*. This value is
     * a generous bound above the observed one, not a prediction of it.
     */
    const BUFFER_CEILING_BYTES = 512 * 1024;

    it('stalls the source while the sink is busy', async () => {
      const ROWS = 80_000;
      const { maxAdvance, totalBytes, written } = await maxAdvanceDuringWrite(ROWS, 500);

      expect(written).toBe(ROWS);
      // Sanity: the document is several times the ceiling, so "it did not read
      // the whole thing" is a statement with content. Without back-pressure
      // this reading is the entire document, every time.
      expect(totalBytes).toBeGreaterThan(BUFFER_CEILING_BYTES * 2);
      expect(maxAdvance).toBeLessThan(BUFFER_CEILING_BYTES);
    });

    it('buffers the same amount whether the document is one megabyte or two', async () => {
      // The property that makes the memory cost a constant rather than a
      // fraction of the upload. Both documents are past the plateau, so if any
      // stage buffered proportionally the larger one would show it.
      const small = await maxAdvanceDuringWrite(40_000, 500);
      const large = await maxAdvanceDuringWrite(80_000, 500);

      expect(large.totalBytes).toBeGreaterThan(small.totalBytes * 1.8);
      expect(large.maxAdvance).toBeLessThanOrEqual(small.maxAdvance * 1.25);
    });
  });
});
