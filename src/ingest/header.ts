import { CsvParseError } from '@/streams/csv.errors';
import type { CsvRecord } from '@/streams/csv-parser';

export interface ColumnSpec {
  /** The name as it must appear in the header, already normalised. */
  readonly name: string;
  readonly required: boolean;
}

/** Which field index each accepted column was found at. */
export type HeaderBinding = ReadonlyMap<string, number>;

/**
 * Trim, then lowercase.
 *
 * Both halves earn their place against real files. Excel and Google Sheets both
 * emit `Email` rather than `email` for a header a human typed, and a hand-edited
 * file routinely carries `email ` with a space that is invisible in every tool
 * anyone would open it in. Neither is a different column, and rejecting a
 * 40,000-row import over the capital E is the kind of strictness that gets an
 * endpoint replaced by a script.
 *
 * What is deliberately *not* normalised: internal whitespace and punctuation.
 * `user email` is not `user_email`; guessing across those is how a column gets
 * silently bound to the wrong one.
 */
export function normaliseHeaderName(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Matches the header record against the columns the caller expects, or refuses
 * the document.
 *
 * Every failure here is `CSV_HEADER_INVALID` and aborts the upload, because a
 * header the server cannot bind is a statement about the whole file: there is
 * no row it could then read correctly, so reading 100,000 of them to reject
 * each in turn wastes the client's bandwidth to arrive at the same answer.
 *
 * Unknown columns are rejected rather than ignored, which is the choice worth
 * defending. Ignoring them is friendlier right up until someone uploads the
 * wrong export — the columns it does share bind, the rest are dropped, and the
 * import succeeds while quietly discarding most of the file. A header is cheap
 * to fix and the failure names exactly which names were not understood.
 */
export function bindHeader(record: CsvRecord, columns: readonly ColumnSpec[]): HeaderBinding {
  const known = new Set(columns.map((column) => column.name));
  const binding = new Map<string, number>();
  const unknown: string[] = [];

  record.fields.forEach((raw, index) => {
    const name = normaliseHeaderName(raw);

    if (!known.has(name)) {
      unknown.push(raw);
      return;
    }
    if (binding.has(name)) {
      throw new CsvParseError(
        'CSV_HEADER_INVALID',
        `Column "${name}" appears more than once in the header`,
        record.line,
      );
    }
    binding.set(name, index);
  });

  if (unknown.length > 0) {
    throw new CsvParseError(
      'CSV_HEADER_INVALID',
      `Unrecognised ${unknown.length === 1 ? 'column' : 'columns'} in the header: ${unknown
        .map((name) => JSON.stringify(name))
        .join(', ')}. Expected: ${columns.map((column) => column.name).join(', ')}`,
      record.line,
    );
  }

  const missing = columns.filter((column) => column.required && !binding.has(column.name));
  if (missing.length > 0) {
    throw new CsvParseError(
      'CSV_HEADER_INVALID',
      `Missing required ${missing.length === 1 ? 'column' : 'columns'}: ${missing
        .map((column) => column.name)
        .join(', ')}`,
      record.line,
    );
  }

  return binding;
}
