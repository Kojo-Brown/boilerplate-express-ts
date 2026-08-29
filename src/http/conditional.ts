import { parseEntityTag, parseEntityTagList, strongMatch, weakMatch } from '@/http/entity-tag';
import type { EntityTag } from '@/http/entity-tag';

/**
 * The read-side conditional request fields: `If-None-Match`, `If-Modified-Since`
 * and `If-Range`, evaluated against a representation's validators.
 *
 * Plain values in, a decision out — no `Request`, no `Response`. The Express
 * half lives in `byte-range.ts`, which is the only thing here that needs to
 * know that `if-none-match` arrives lower-cased on an object.
 *
 * The write-side fields (`If-Match`, `If-Unmodified-Since`) are not evaluated
 * here and are not evaluated on this API's reads at all: `@/concurrency` owns
 * `If-Match`, where it guards a `PATCH` against a lost update. A GET is not a
 * state change, so the only thing an `If-Match` on one could do is turn a
 * cache miss into a 412.
 */

/** What the origin currently holds, in the form the response advertises it. */
export interface Validators {
  /** The `ETag` field value, quotes and any `W/` included. */
  readonly etag: string;
  /** The `Last-Modified` instant, if the representation has one. */
  readonly lastModified?: Date;
}

export type ReadPrecondition =
  /** Send the representation (or the range asked for). */
  | 'proceed'
  /** 304: the client's copy is current. */
  | 'not-modified';

export interface ConditionalHeaders {
  readonly ifNoneMatch?: string | undefined;
  readonly ifModifiedSince?: string | undefined;
}

/**
 * `If-None-Match`, falling back to `If-Modified-Since`.
 *
 * The fallback is one-way and unconditional: RFC 9110 §13.1.3 says a recipient
 * that has an `If-None-Match` **must ignore** `If-Modified-Since`. That is not a
 * tidiness rule. A client sends both so that an origin with only one kind of
 * validator can still answer; evaluating both and requiring both to pass turns
 * every re-validation of a file whose mtime moved but whose bytes did not into
 * a full transfer.
 */
export function evaluateReadPreconditions(
  headers: ConditionalHeaders,
  validators: Validators,
): ReadPrecondition {
  if (headers.ifNoneMatch !== undefined) {
    return matchesIfNoneMatch(headers.ifNoneMatch, validators.etag) ? 'not-modified' : 'proceed';
  }

  if (headers.ifModifiedSince !== undefined && validators.lastModified !== undefined) {
    const since = parseHttpDate(headers.ifModifiedSince);
    if (since === null) return 'proceed';
    // Second granularity, because that is all an HTTP-date carries: a
    // millisecond-precise `lastModified` is otherwise *always* strictly greater
    // than the date derived from the response that carried it, and the resource
    // never validates.
    return truncateToSeconds(validators.lastModified) <= since ? 'not-modified' : 'proceed';
  }

  return 'proceed';
}

/**
 * Whether a `Range` may be applied, given `If-Range`.
 *
 * This is the field that makes resuming a download safe, and its logic is
 * inverted from every other precondition: a *failed* `If-Range` is not an
 * error, it is an instruction to ignore the `Range` and send the whole thing.
 * The client asked "give me bytes 5000– if this is still the file I was
 * downloading, otherwise start again", and 200 is the second half of that
 * sentence. Answering 412 would strand a client that is perfectly able to
 * restart.
 *
 * Absent `If-Range` means the range applies unconditionally — the client took
 * responsibility for the representation being stable.
 */
export function shouldApplyRange(
  ifRange: string | undefined,
  validators: Validators,
): boolean {
  if (ifRange === undefined) return true;

  const tag = parseEntityTag(ifRange);
  if (tag !== null) {
    const current = parseEntityTag(validators.etag);
    // Strong comparison, and a weak current tag therefore never matches. A weak
    // validator means "equivalent representations", and two equivalent
    // representations may still differ byte for byte — which is exactly what a
    // range request cannot tolerate, because the client is splicing these bytes
    // onto bytes it already holds.
    return current !== null && strongMatch(tag, current);
  }

  // Not an entity-tag, so it is an HTTP-date, compared for exact equality
  // rather than for "not newer": a representation that changed twice within the
  // same second has the same `Last-Modified` and a date that merely is not
  // older would accept it.
  const date = parseHttpDate(ifRange);
  if (date === null || validators.lastModified === undefined) return false;
  return truncateToSeconds(validators.lastModified) === date;
}

function matchesIfNoneMatch(header: string, currentETag: string): boolean {
  // `*` means "if any representation exists". Reaching this function at all
  // means one does.
  if (header.trim() === '*') return true;

  const tags = parseEntityTagList(header);
  // A malformed `If-None-Match` is ignored rather than rejected, for the same
  // reason a malformed `Range` is: the conservative reading (send the content)
  // is always correct, and 400 would fail a request that a plain GET would have
  // served.
  if (tags === null) return false;

  const current = parseEntityTag(currentETag);
  if (current === null) return false;

  // Weak comparison — RFC 9110 §13.1.2. `If-None-Match` asks "is my copy still
  // good enough", and a weak validator is precisely a claim that it is.
  return tags.some((tag: EntityTag) => weakMatch(tag, current));
}

/**
 * An HTTP-date, as epoch milliseconds truncated to the second.
 *
 * `Date.parse` is lenient where the spec requires leniency — recipients must
 * accept IMF-fixdate, the obsolete RFC 850 form and asctime — and lenient in
 * ways it does not, which costs nothing here: a header this cannot make sense of
 * and a header it over-generously accepts both end in the same place, serving
 * the content.
 */
function parseHttpDate(value: string): number | null {
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000) * 1000;
}

function truncateToSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000) * 1000;
}
