/** One row the document described and the ingest refused. */
export interface RowError {
  /** 1-based line in the uploaded file, so the operator can open it and look. */
  readonly line: number;
  /** The column at fault, when the failure is attributable to one. */
  readonly column?: string;
  readonly message: string;
}

/**
 * What an ingest did.
 *
 * `accepted` and `written` are separate on purpose and the gap between them is
 * information, not noise: a row can validate, be handed to the sink, and not
 * become a new row — a duplicate email under `ON CONFLICT DO NOTHING` is the
 * ordinary case. Reporting only one number forces the caller to guess which,
 * and "I uploaded 500 and it says 500" reads as success whether or not anything
 * changed.
 */
export interface IngestSummary {
  /** Data records parsed. The header is not one. */
  readonly recordsRead: number;
  /** Records that validated and were passed to the sink. */
  readonly accepted: number;
  /** Rows the sink reports it actually wrote. */
  readonly written: number;
  /** Records that parsed into fields and then failed validation. */
  readonly rejected: number;
  /** Up to `maxReportedErrors` of the rejections, in the order they occurred. */
  readonly errors: readonly RowError[];
  /** Whether `errors` is shorter than `rejected`. */
  readonly errorsTruncated: boolean;
}

/**
 * Collects row rejections under a cap.
 *
 * The cap is not tidiness. A response body is built in memory and sent in one
 * write, so an import of a million rows against the wrong file — every row
 * rejected — would otherwise assemble a million error objects to explain it:
 * an out-of-memory on the *error* path, reached only when something is already
 * going wrong. The count stays exact regardless; it is the detail that is
 * bounded, and `errorsTruncated` says so rather than letting a client read a
 * short list as a complete one.
 */
export class RowErrorSink {
  private readonly collected: RowError[] = [];
  private count = 0;

  constructor(private readonly maxReported: number) {
    if (!Number.isInteger(maxReported) || maxReported < 0) {
      throw new RangeError(
        `RowErrorSink: maxReported must be a non-negative integer, received ${String(maxReported)}`,
      );
    }
  }

  record(error: RowError): void {
    this.count += 1;
    if (this.collected.length < this.maxReported) this.collected.push(error);
  }

  get rejected(): number {
    return this.count;
  }

  get errors(): readonly RowError[] {
    return this.collected;
  }

  get truncated(): boolean {
    return this.count > this.collected.length;
  }
}
