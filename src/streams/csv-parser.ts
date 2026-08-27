import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { CsvParseError } from '@/streams/csv.errors';

/** One parsed record, and where it started. */
export interface CsvRecord {
  /** 1-based line the record began on, for error messages a human can act on. */
  readonly line: number;
  readonly fields: readonly string[];
}

export interface CsvParserOptions {
  /** Single character. Default `,`. */
  readonly delimiter?: string;
  /** Single character. Default `"`. */
  readonly quote?: string;
  /**
   * The largest record the parser will accumulate, in UTF-16 code units.
   *
   * This is the bound that keeps a hostile or corrupt upload from becoming an
   * out-of-memory kill, and it is not optional in the way it looks. A parser
   * that emits on a terminator holds the current record in memory until it
   * finds one, so a 4 GB file containing no delimiter at all is a 4 GB string —
   * and every hand-rolled line splitter that reads `chunk.toString()` into a
   * `buffer += ` has exactly this hole. The stream's `highWaterMark` does not
   * help: it bounds what the stream buffers on the caller's behalf, not what
   * the transform chooses to keep.
   *
   * Counted in code units rather than bytes because code units are what is
   * actually retained — a byte count would have to be recomputed over the
   * accumulated string on every run, and for the ASCII a CSV is mostly made of
   * the two numbers agree anyway.
   */
  readonly maxRecordChars?: number;
  /**
   * Records buffered on the readable side before the parser stops pulling.
   *
   * One, not the object-mode default of sixteen. The parser sits upstream of a
   * batcher and a database write, and every record buffered here is a record
   * whose bytes have already been read off the socket — buffering sixteen of
   * them at each of three object-mode stages is how a chain that "uses
   * backpressure" still ends up holding far more of the upload than anyone
   * intended. See `docs/csv-ingest.md`.
   */
  readonly highWaterMark?: number;
}

export const DEFAULT_MAX_RECORD_CHARS = 1024 * 1024;

/**
 * States of the RFC 4180 grammar. `AfterQuote` is the one that is easy to leave
 * out and the reason `""` works: having read a quote while inside a quoted
 * field, the parser cannot yet say whether the field ended or an escaped quote
 * began, and the next character decides.
 */
const enum State {
  FieldStart,
  Unquoted,
  Quoted,
  AfterQuote,
}

/**
 * A streaming RFC 4180 parser: bytes in, records out.
 *
 * ## Why not a line splitter plus `split(',')`
 *
 * Because a CSV record is not a line. A quoted field may contain the delimiter,
 * the quote character, and — the one that breaks every naive implementation —
 * newlines. Splitting on `\n` first shreds such a record into pieces that no
 * later pass can reassemble, because by then the information that the newline
 * was inside quotes is gone.
 *
 * ## Why the state lives on the instance
 *
 * A chunk boundary can fall anywhere: between the two quotes of an escaped `""`,
 * between `\r` and `\n`, in the middle of a quoted field that spans lines. This
 * parser keeps *no raw text buffer at all* — the state machine's position, the
 * field under construction and the fields already closed persist across
 * `_transform` calls, so a boundary is simply the point at which one call ends
 * and the next resumes. That is what makes chunk size irrelevant to the result,
 * which is the property a streaming parser has to have and the one that is
 * hardest to retrofit.
 *
 * ## Why `StringDecoder`
 *
 * `chunk.toString('utf8')` on a chunk that ends mid-sequence produces U+FFFD
 * and drops the character, permanently. A 3-byte `€` split 2/1 across a TCP
 * segment corrupts silently — and it only happens on some payloads at some
 * sizes, so it survives every test written against a single-chunk fixture.
 * `StringDecoder` holds the incomplete tail until the bytes that finish it
 * arrive.
 */
export class CsvParser extends Transform {
  private readonly delimiter: string;
  private readonly quote: string;
  private readonly maxRecordChars: number;
  private readonly decoder = new StringDecoder('utf8');

  private state: State = State.FieldStart;
  private field = '';
  private fields: string[] = [];
  /** The line the parser is currently reading. */
  private line = 1;
  /** The line the record under construction began on. */
  private recordLine = 1;
  /**
   * Whether the record under construction has seen anything at all — including
   * a quote that produced no characters. It is what separates a blank line,
   * which is skipped, from a line holding one explicitly empty quoted field,
   * which is a record whose single field is the empty string.
   */
  private recordTouched = false;
  private recordChars = 0;
  /** A `\r` is only a terminator if it is not followed by `\n`; this defers that. */
  private pendingCr = false;
  private atStart = true;

  constructor(options: CsvParserOptions = {}) {
    super({
      readableObjectMode: true,
      writableObjectMode: false,
      readableHighWaterMark: options.highWaterMark ?? 1,
    });

    this.delimiter = options.delimiter ?? ',';
    this.quote = options.quote ?? '"';
    this.maxRecordChars = options.maxRecordChars ?? DEFAULT_MAX_RECORD_CHARS;

    if (this.delimiter.length !== 1 || this.quote.length !== 1) {
      throw new RangeError('CsvParser: delimiter and quote must each be a single character');
    }
    if (this.delimiter === this.quote) {
      throw new RangeError('CsvParser: delimiter and quote must differ');
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.consume(this.decoder.write(chunk));
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      // Whatever the decoder is still holding. An incomplete sequence at true
      // end-of-input is genuinely truncated data, and becomes U+FFFD here
      // rather than being dropped without trace.
      this.consume(this.decoder.end());

      // A trailing `\r` with nothing after it is a terminator after all.
      if (this.pendingCr) {
        this.pendingCr = false;
        this.closeRecord();
      }

      if (this.state === State.Quoted) {
        throw new CsvParseError(
          'CSV_UNTERMINATED_QUOTE',
          'Quoted field is not closed before the end of the input',
          this.recordLine,
        );
      }

      // `AfterQuote` at end-of-input is a *closed* field — the quote was the
      // last character — so the record is complete and is emitted.
      if (this.recordTouched) this.closeRecord();

      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  private consume(text: string): void {
    if (text.length === 0) return;

    let input = text;

    // A UTF-8 BOM is a byte-order mark, not data, and Excel writes one on every
    // CSV it exports. Left in place it becomes part of the first header name, so
    // the column reads as U+FEFF followed by `email`, fails to match `email`,
    // and the file is rejected for a missing column that is plainly there.
    // Stripped only at true offset zero, because U+FEFF anywhere else is a
    // zero-width no-break space the document meant to contain.
    if (this.atStart) {
      this.atStart = false;
      if (input.startsWith('\uFEFF')) input = input.slice(1);
    }

    let i = 0;
    while (i < input.length) {
      // A `\r` seen at the end of the previous chunk: resolve it now that the
      // next character is known.
      if (this.pendingCr) {
        this.pendingCr = false;
        this.closeRecord();
        if (input[i] === '\n') {
          i += 1;
          continue;
        }
      }

      switch (this.state) {
        case State.FieldStart:
          i = this.readFieldStart(input, i);
          break;
        case State.Unquoted:
          i = this.readUnquoted(input, i);
          break;
        case State.Quoted:
          i = this.readQuoted(input, i);
          break;
        case State.AfterQuote:
          i = this.readAfterQuote(input, i);
          break;
      }
    }
  }

  private readFieldStart(input: string, i: number): number {
    const char = input[i];

    if (char === this.quote) {
      this.recordTouched = true;
      this.state = State.Quoted;
      return i + 1;
    }

    this.state = State.Unquoted;
    return i;
  }

  /**
   * Consumes a run of ordinary characters in one slice rather than one
   * concatenation per character. On a 50 MB file the difference is not a
   * micro-optimisation: `field += char` in a loop is quadratic in the length of
   * the field for engines that cannot rope the result, and the whole point of
   * streaming is that the parser is not the bottleneck.
   */
  private readUnquoted(input: string, i: number): number {
    let cursor = i;

    while (cursor < input.length) {
      const char = input[cursor];
      if (char === this.delimiter || char === '\n' || char === '\r') break;
      cursor += 1;
    }

    if (cursor > i) {
      this.recordTouched = true;
      this.append(input.slice(i, cursor));
    }

    if (cursor >= input.length) return cursor;

    const char = input[cursor];
    if (char === this.delimiter) {
      this.recordTouched = true;
      this.closeField();
      return cursor + 1;
    }

    return this.terminate(input, cursor);
  }

  private readQuoted(input: string, i: number): number {
    let cursor = i;

    while (cursor < input.length) {
      const char = input[cursor];
      if (char === this.quote) break;
      // Newlines inside a quoted field are content, but they are still lines:
      // counting them here is what keeps a reported line number pointing at the
      // right place in the file rather than at the right place among records.
      if (char === '\n') this.line += 1;
      cursor += 1;
    }

    if (cursor > i) this.append(input.slice(i, cursor));
    if (cursor >= input.length) return cursor;

    this.state = State.AfterQuote;
    return cursor + 1;
  }

  private readAfterQuote(input: string, i: number): number {
    const char = input[i];

    // `""` — an escaped quote, and the field continues.
    if (char === this.quote) {
      this.append(this.quote);
      this.state = State.Quoted;
      return i + 1;
    }

    if (char === this.delimiter) {
      this.closeField();
      this.state = State.FieldStart;
      return i + 1;
    }

    if (char === '\n' || char === '\r') {
      this.state = State.FieldStart;
      return this.terminate(input, i);
    }

    // Anything else is a quote the grammar has no reading for: `"a"b` is neither
    // a quoted field nor an unquoted one. Guessing here is how a parser turns a
    // corrupt export into plausible-looking rows, so it refuses and names the
    // line.
    throw new CsvParseError(
      'CSV_INVALID_QUOTE',
      `Unexpected ${JSON.stringify(char)} after a closing quote; expected a delimiter, a line break, or an escaped quote`,
      this.line,
    );
  }

  /** Handles the terminator at `i`, which is known to be `\n` or `\r`. */
  private terminate(input: string, i: number): number {
    if (input[i] === '\n') {
      this.closeRecord();
      return i + 1;
    }

    // `\r`: a terminator on its own (classic Mac) or the first half of `\r\n`.
    // Deciding needs the next character, which may be in the next chunk.
    if (i + 1 < input.length) {
      this.closeRecord();
      return input[i + 1] === '\n' ? i + 2 : i + 1;
    }

    this.pendingCr = true;
    return i + 1;
  }

  private append(text: string): void {
    this.recordChars += text.length;
    if (this.recordChars > this.maxRecordChars) {
      throw new CsvParseError(
        'CSV_RECORD_TOO_LARGE',
        `Record exceeds the ${String(this.maxRecordChars)} character limit`,
        this.recordLine,
      );
    }
    this.field += text;
  }

  private closeField(): void {
    this.fields.push(this.field);
    this.field = '';
    this.state = State.FieldStart;
  }

  private closeRecord(): void {
    this.line += 1;

    // A blank line — no characters, no delimiters, no quotes — separates
    // records rather than being one, and a trailing newline at end of file is
    // the common case. `recordTouched` and not `field === '' && fields.length
    // === 0`, because a line holding just `""` has produced no characters
    // either and *is* a record with one empty field.
    if (!this.recordTouched) {
      this.resetRecord();
      return;
    }

    this.fields.push(this.field);
    const record: CsvRecord = { line: this.recordLine, fields: this.fields };
    this.resetRecord();
    this.push(record);
  }

  private resetRecord(): void {
    this.field = '';
    this.fields = [];
    this.state = State.FieldStart;
    this.recordTouched = false;
    this.recordChars = 0;
    this.recordLine = this.line;
  }
}
