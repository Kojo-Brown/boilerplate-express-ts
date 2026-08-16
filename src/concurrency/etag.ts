import { ANY_VERSION } from '@/concurrency/concurrency.types';
import type { Precondition } from '@/concurrency/concurrency.types';

/**
 * RFC 9110's entity-tag rules, and nothing else. No Express types, no status
 * codes, no errors — a parse failure is *returned* rather than thrown, so this
 * module stays a codec that a test can exercise on strings alone and the
 * decision about what a bad header costs a client lives in `precondition.ts`
 * with the rest of the HTTP contract.
 */

/** The validator this API hands out on a versioned representation. */
export const ETAG_HEADER = 'ETag';

/** The validator a client sends back to make its write conditional. */
export const IF_MATCH_HEADER = 'If-Match';

/**
 * `version` is a Postgres `integer`, so this is the largest value a row can
 * reach. A tag above it cannot name any row, which makes it unmatchable rather
 * than malformed — see `toVersion`.
 */
const MAX_VERSION = 2_147_483_647;

/**
 * Exactly the shape `formatETag` emits: decimal, no leading zeros, no sign.
 *
 * The narrowness is the point. `If-Match` is defined by *strong comparison*,
 * which is octet equality of the opaque tag, so `"007"` and `"7"` are two
 * different tags and only one of them is ours. Accepting anything a `Number()`
 * would swallow would quietly turn the strong comparison this API promises into
 * a numeric one.
 */
const VERSION_TAG = /^[1-9][0-9]{0,9}$/;

interface EntityTag {
  readonly weak: boolean;
  readonly value: string;
}

/**
 * A parsed `If-Match`, or the reason it could not be one.
 *
 * The reason is a sentence rather than a code because there is exactly one
 * caller and what it needs is something to put in front of a client: the two
 * failures — "that is not an entity-tag list" and "that tag is weak" — differ
 * only in the explanation owed.
 */
export type IfMatchResult =
  | { readonly ok: true; readonly precondition: Precondition }
  | { readonly ok: false; readonly reason: string };

/**
 * The `ETag` for a row at `version`.
 *
 * Strong, not `W/`-weak, and that is forced rather than chosen: RFC 9110
 * evaluates `If-Match` by strong comparison, so a weak tag handed to a client
 * is a tag that can never satisfy the conditional write it exists to enable.
 *
 * It is a sound strong validator because `version` moves on every write to the
 * row — the database trigger, not the application, is what guarantees that. The
 * envelope's `meta` (`cache: 'hit'`) does vary between two responses carrying
 * the same tag; it is per-response diagnostics about how the answer was
 * obtained, not part of the resource being tagged.
 */
export function formatETag(version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new RangeError(`Cannot build an ETag from version ${version}`);
  }
  return `"${version}"`;
}

/**
 * An `If-Match` header value reduced to the thing a conditional write needs.
 *
 * Three outcomes, and the split between them is the whole contract:
 *
 * - `*` means "whatever version it is at, as long as it is still there".
 * - A syntactically bad header, or one carrying a weak tag, is a client bug and
 *   fails. Answering 412 instead would be indistinguishable from a genuine
 *   version conflict, and a client retrying a `W/`-prefixed tag would loop
 *   forever against an API that can never accept it.
 * - Tags that parse but cannot name a version — `"abc"`, `"007"`, a value past
 *   `MAX_VERSION` — are dropped, not rejected. They are well-formed tags that
 *   simply do not match, which is a 412 and not a 400. Dropping every tag
 *   leaves an empty list, and an empty list matches nothing, which is exactly
 *   right.
 */
export function parseIfMatch(header: string): IfMatchResult {
  const trimmed = header.trim();

  // `*` is a whole field value, never a member of a list: `If-Match: "1", *` is
  // not valid, and the scanner below rejects it for us.
  if (trimmed === '*') return { ok: true, precondition: ANY_VERSION };

  const tags = parseEntityTagList(trimmed);
  if (tags === null) {
    return { ok: false, reason: 'expected "*" or a comma-separated list of entity-tags' };
  }

  if (tags.some((tag) => tag.weak)) {
    return {
      ok: false,
      reason:
        'weak entity-tags (W/"...") can never satisfy If-Match, which is evaluated by strong comparison',
    };
  }

  const versions: number[] = [];
  for (const tag of tags) {
    const version = toVersion(tag.value);
    if (version !== null) versions.push(version);
  }

  return { ok: true, precondition: { kind: 'versions', versions } };
}

/** The version a tag names, or `null` for a tag no row can ever carry. */
function toVersion(value: string): number | null {
  if (!VERSION_TAG.test(value)) return null;
  const version = Number(value);
  return version <= MAX_VERSION ? version : null;
}

/**
 * `1#entity-tag` from RFC 9110, scanned rather than split on commas.
 *
 * `header.split(',')` is the obvious implementation and is wrong: a comma is a
 * legal character *inside* an entity-tag, so splitting tears `"a,b"` into two
 * malformed halves. This walks the string instead, which costs a dozen lines
 * and cannot misread a tag.
 *
 * Returns `null` for anything that is not a well-formed list.
 */
function parseEntityTagList(header: string): EntityTag[] | null {
  const tags: EntityTag[] = [];
  let i = 0;

  const skipOws = (): void => {
    while (i < header.length && (header[i] === ' ' || header[i] === '\t')) i++;
  };

  // The `#` rule tolerates empty members — `"1", , "2"` — so commas are eaten
  // greedily as separators. An empty list is still not a list, which the
  // length check at the end enforces.
  const skipSeparators = (): void => {
    skipOws();
    while (i < header.length && header[i] === ',') {
      i++;
      skipOws();
    }
  };

  skipSeparators();

  while (i < header.length) {
    const read = readEntityTag(header, i);
    if (read === null) return null;
    tags.push(read.tag);
    i = read.next;

    skipOws();
    if (i >= header.length) break;
    // Anything other than a separator here is junk between tags — including
    // another tag, since `"1""2"` is two values with no list between them.
    if (header[i] !== ',') return null;
    skipSeparators();
  }

  return tags.length > 0 ? tags : null;
}

function readEntityTag(header: string, start: number): { tag: EntityTag; next: number } | null {
  let i = start;
  let weak = false;

  if (header.startsWith('W/', i)) {
    weak = true;
    i += 2;
  }

  if (header[i] !== '"') return null;
  i++;

  const valueStart = i;
  while (i < header.length && header[i] !== '"') {
    if (!isEtagChar(header.charCodeAt(i))) return null;
    i++;
  }

  // Ran off the end without a closing quote.
  if (i >= header.length) return null;

  return { tag: { weak, value: header.slice(valueStart, i) }, next: i + 1 };
}

/** `etagc = %x21 / %x23-7E / obs-text`. Excludes `"`, controls and DEL. */
function isEtagChar(code: number): boolean {
  return code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}
