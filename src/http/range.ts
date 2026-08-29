/**
 * RFC 9110 §14 range requests: the `Range` grammar, and resolving what it asks
 * for against a representation whose length is known.
 *
 * Parsing and resolution are separate functions on purpose. The grammar has no
 * idea how big anything is, and the three outcomes a *resolution* can have —
 * serve a range, refuse with 416, or ignore the header and serve everything —
 * are decisions that need the size and nothing else. Keeping them apart is what
 * lets both be tested exhaustively on plain values, and it is the difference
 * between the two failure modes that matter here:
 *
 * - a **malformed** `Range` is ignored (200, full content). RFC 9110 §14.2 is
 *   explicit: a recipient must ignore a `Range` it cannot parse. Answering 400
 *   would break a client whose only sin was an unrecognised range unit.
 * - an **unsatisfiable** `Range` — well-formed, but naming bytes the
 *   representation does not have — is 416. Serving the whole thing instead would
 *   silently hand a resuming download the bytes it already had, at the offset it
 *   asked to skip past.
 */

/** An inclusive, resolved byte interval. `end` is a byte that exists. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** One member of a `range-set`, as written by the client. */
export type RangeSpec =
  /** `first-pos "-" [ last-pos ]` — `last` is `null` for an open-ended range. */
  | { readonly kind: 'int'; readonly first: number; readonly last: number | null }
  /** `"-" suffix-length` — the final `length` bytes. */
  | { readonly kind: 'suffix'; readonly length: number };

export type RangeResolution =
  /** Serve the whole representation with 200. */
  | { readonly kind: 'ignore' }
  /** 416, with `Content-Range: bytes * /size`. */
  | { readonly kind: 'unsatisfiable' }
  /** 206, over exactly this interval. */
  | { readonly kind: 'range'; readonly range: ByteRange };

/**
 * Beyond this many digits a position is not read as a number.
 *
 * `bytes=0-99999999999999999999` parses as a `Number` that has lost precision,
 * and precision loss on a byte offset is not a rounding error — it is an
 * off-by-a-few-kilobytes in a `Content-Range` the client will trust. Anything
 * longer than a plausible offset is clamped to `MAX_SAFE_INTEGER`, which
 * compares correctly against every real size (a last-pos above the size clamps
 * to the last byte; a first-pos above it is unsatisfiable) without ever being
 * arithmetic on an inexact value.
 */
const MAX_POSITION_DIGITS = 15;

const DIGITS = /^[0-9]+$/;

/**
 * A `Range` field value, or `null` if it is not one this server understands.
 *
 * `null` covers both "not valid per the grammar" and "a range unit other than
 * `bytes`"; the caller ignores the header either way, which is what the RFC
 * requires for both.
 *
 * The returned list is what the client wrote, in order, unmerged and
 * unvalidated against any size — `resolveRange` owns that half.
 */
export function parseRangeHeader(header: string): RangeSpec[] | null {
  const equals = header.indexOf('=');
  if (equals === -1) return null;

  // `range-unit` is a token, and tokens are compared case-insensitively.
  if (header.slice(0, equals).trim().toLowerCase() !== 'bytes') return null;

  const specs: RangeSpec[] = [];

  // A comma cannot occur inside a byte-range-spec — the grammar is digits and a
  // hyphen — so unlike an entity-tag list this one can be split. The `#` rule
  // tolerates empty members, which is why blanks are skipped rather than
  // rejected; a list of nothing but blanks is still not a list.
  for (const raw of header.slice(equals + 1).split(',')) {
    const part = raw.trim();
    if (part === '') continue;

    const spec = parseRangeSpec(part);
    if (spec === null) return null;
    specs.push(spec);
  }

  return specs.length > 0 ? specs : null;
}

function parseRangeSpec(part: string): RangeSpec | null {
  const hyphen = part.indexOf('-');
  if (hyphen === -1) return null;

  const before = part.slice(0, hyphen);
  const after = part.slice(hyphen + 1);

  // No whitespace is permitted *inside* a byte-range-spec, so `parsePosition`
  // is deliberately strict: `bytes=0 - 10` is malformed, not generous.
  if (before === '') {
    const length = parsePosition(after);
    return length === null ? null : { kind: 'suffix', length };
  }

  const first = parsePosition(before);
  if (first === null) return null;

  if (after === '') return { kind: 'int', first, last: null };

  const last = parsePosition(after);
  // `last-pos` present and below `first-pos` is invalid, not unsatisfiable:
  // there is no interval it could name, so there is nothing for a 416's
  // `Content-Range` to be about.
  if (last === null || last < first) return null;

  return { kind: 'int', first, last };
}

function parsePosition(text: string): number | null {
  if (!DIGITS.test(text)) return null;
  // Leading zeros are legal — `1*DIGIT`, not a constrained numeric form — so
  // the length check strips them first rather than rejecting `0000000000000001`.
  const digits = text.replace(/^0+(?=[0-9])/, '');
  return digits.length > MAX_POSITION_DIGITS ? Number.MAX_SAFE_INTEGER : Number(digits);
}

/**
 * What a parsed `Range` means for a representation of `size` bytes.
 *
 * ## Why more than one range is ignored rather than served
 *
 * A 206 answering a multi-range request has to be a `multipart/byteranges`
 * body: it is not permissible to answer with just one of the ranges asked for,
 * because the client cannot tell which. Generating that body means inventing a
 * boundary, repeating a part header per range, and computing the total length
 * up front so `Content-Length` can still be sent — for a feature whose real
 * users (a resuming download, a video player seeking, `curl -C -`) all send
 * exactly one range. RFC 9110 §14.2 permits ignoring `Range` at any time, so a
 * multi-range request gets the whole representation, which is always a correct
 * answer to it.
 *
 * ## Zero-length representations
 *
 * Every range against a zero-byte object is unsatisfiable, and that falls out
 * rather than being special-cased: `first >= size` holds for `first = 0`, and a
 * suffix of any length has no last byte to end at.
 */
export function resolveRange(specs: readonly RangeSpec[], size: number): RangeResolution {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`resolveRange: size must be a non-negative integer, received ${size}`);
  }

  if (specs.length !== 1) return { kind: 'ignore' };

  const spec = specs[0];
  if (spec === undefined) return { kind: 'ignore' };

  if (spec.kind === 'suffix') {
    // `bytes=-0` asks for the last zero bytes. It is well-formed and names
    // nothing, which is the definition of unsatisfiable.
    if (spec.length === 0 || size === 0) return { kind: 'unsatisfiable' };
    // A suffix longer than the representation is the whole representation, not
    // an error: "the last 5000 bytes" of a 100-byte file is those 100 bytes.
    return { kind: 'range', range: { start: Math.max(0, size - spec.length), end: size - 1 } };
  }

  if (spec.first >= size) return { kind: 'unsatisfiable' };

  // A `last-pos` past the end is clamped rather than refused — `bytes=0-` and
  // `bytes=0-999999` are the same request against a 100-byte file, and both are
  // how a client asks for "the rest".
  const end = spec.last === null ? size - 1 : Math.min(spec.last, size - 1);
  return { kind: 'range', range: { start: spec.first, end } };
}

/** The `Content-Range` for a 206: `bytes <start>-<end>/<size>`. */
export function formatContentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}

/**
 * The `Content-Range` for a 416: `bytes * /<size>`.
 *
 * Required, not optional — it is the only thing that tells a client resuming a
 * download that its idea of the length is stale, and the only way it can work
 * out what to ask for instead.
 */
export function formatUnsatisfiedRange(size: number): string {
  return `bytes */${size}`;
}

/** Bytes in an inclusive interval. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}
