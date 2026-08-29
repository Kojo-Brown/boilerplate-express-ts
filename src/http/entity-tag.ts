/**
 * RFC 9110 §8.8.3 entity-tags: the grammar and the two comparison functions,
 * and deliberately nothing above them — no status codes, no Express, no idea
 * what a tag is *for*.
 *
 * There are two callers with genuinely different needs and they must not each
 * own a copy of the scanner. `concurrency/etag.ts` reads `If-Match` on a write,
 * where a tag names a row `version` and comparison is strong; `http/conditional.ts`
 * reads `If-None-Match` and `If-Range` on a read, where a tag is opaque and
 * `If-None-Match` is defined by *weak* comparison. The part they share is the
 * one that is easy to get subtly wrong — the list grammar — so that is what
 * lives here.
 */

export interface EntityTag {
  /** `W/`-prefixed: the representation is equivalent, not byte-identical. */
  readonly weak: boolean;
  /** The opaque quoted-string contents, without the quotes. */
  readonly value: string;
}

/**
 * Strong comparison (RFC 9110 §8.8.3.2): both tags strong, and octet-equal.
 *
 * `If-Match` and `If-Range` are defined in terms of this. A weak tag on either
 * side can never match, which is not a technicality: it is what stops a range
 * request from being stitched onto bytes from a different representation that
 * merely means the same thing.
 */
export function strongMatch(a: EntityTag, b: EntityTag): boolean {
  return !a.weak && !b.weak && a.value === b.value;
}

/**
 * Weak comparison (RFC 9110 §8.8.3.2): octet-equal values, weakness ignored.
 *
 * `If-None-Match` is defined in terms of this, which is why a cache holding
 * `W/"v1"` is allowed to be told 304 by an origin whose current tag is `"v1"`.
 */
export function weakMatch(a: EntityTag, b: EntityTag): boolean {
  return a.value === b.value;
}

/** Renders a tag back to its wire form, quotes and `W/` included. */
export function formatEntityTag(tag: EntityTag): string {
  return `${tag.weak ? 'W/' : ''}"${tag.value}"`;
}

/**
 * One entity-tag on its own, for the fields that take a single value rather
 * than a list — `If-Range` is the only one. Returns `null` for anything that is
 * not exactly one well-formed tag, trailing junk included.
 */
export function parseEntityTag(header: string): EntityTag | null {
  const trimmed = header.trim();
  const read = readEntityTag(trimmed, 0);
  if (read === null || read.next !== trimmed.length) return null;
  return read.tag;
}

/**
 * `1#entity-tag` from RFC 9110, scanned rather than split on commas.
 *
 * `header.split(',')` is the obvious implementation and is wrong: a comma is a
 * legal character *inside* an entity-tag, so splitting tears `"a,b"` into two
 * malformed halves. This walks the string instead, which costs a dozen lines
 * and cannot misread a tag.
 *
 * Returns `null` for anything that is not a well-formed list. `*` is not a
 * member of this grammar — it is a whole field value, and rejecting it here is
 * what stops `If-None-Match: "1", *` from being accepted by either caller.
 */
export function parseEntityTagList(header: string): EntityTag[] | null {
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
export function isEtagChar(code: number): boolean {
  return code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
}
