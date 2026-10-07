/**
 * Proactive content negotiation for `Accept` (RFC 9110 §12.5.1).
 *
 * Built red→green→refactor; see `docs/tdd-kata.md`.
 *
 * A note on these comments: the full wildcard media range is written
 * "star-slash-star" in prose, never as the literal, because the literal closes
 * a block comment. Earlier drafts smuggled a zero-width space into it, which
 * compiled and left an invisible character in a string a reader would copy.
 */

interface MediaRange {
  readonly type: string;
  readonly subtype: string;
  /** The member's `q`, defaulted to 1. `0` is a refusal, not a low ranking. */
  readonly quality: number;
}

/**
 * How specific a range is, so that the one which *speaks for* an offer can be
 * picked out of the several that match it: `text/plain` over `text/*` over
 * star-slash-star. Only the winner's weight counts, which is what makes a field
 * pairing a broad `q=1` with a narrow `q=0` a refusal and not a tie.
 */
function specificity(range: MediaRange): number {
  if (range.type === '*') return 0;
  if (range.subtype === '*') return 1;
  return 2;
}

function matches(range: MediaRange, type: string, subtype: string): boolean {
  if (range.type === '*') return true;
  if (range.type !== type) return false;
  return range.subtype === '*' || range.subtype === subtype;
}

/**
 * `qvalue` from RFC 9110 §12.4.2: `0`–`1`, at most three decimals, no sign and
 * no exponent. Returns `null` for anything else, which makes the member
 * malformed.
 *
 * Strict because the lenient version silently invents a preference. `Number()`
 * reads `1.5` as 1.5, `-0.5` as a negative, `1e-3` as 0.001 and the empty
 * string as 0 — and that last one turns a client's typo into a refusal of the
 * very thing it asked for, which is the worst available answer.
 */
function parseQuality(value: string): number | null {
  if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(value)) return null;
  return Number(value);
}

/**
 * One media range with its parameters: `type/subtype`, lowercased, plus `q`.
 * `null` when it is not that shape.
 */
function parseMediaRange(member: string): MediaRange | null {
  const [mediaType, ...parameters] = member.split(';');
  if (mediaType === undefined) return null;

  const slash = mediaType.indexOf('/');
  if (slash === -1) return null;

  const type = mediaType.slice(0, slash).trim().toLowerCase();
  const subtype = mediaType.slice(slash + 1).trim().toLowerCase();
  if (type === '' || subtype === '') return null;
  if (subtype.includes('/')) return null;

  // A wildcard type pairs only with a wildcard subtype: `*/json` is not in the
  // grammar, and admitting it would give it a meaning this parser invented,
  // which no other server would agree with.
  if (type === '*' && subtype !== '*') return null;

  let quality = 1;

  for (const parameter of parameters) {
    const equals = parameter.indexOf('=');
    if (equals === -1) return null;

    const name = parameter.slice(0, equals).trim().toLowerCase();
    const value = parameter.slice(equals + 1).trim();
    if (name === '') return null;

    // Only `q` is read. The rest of the parameters are the media type's own and
    // belong to cycle 4, where they start deciding specificity; until then they
    // have to be *accepted* rather than ignored, because a field carrying
    // `version=0.0.4` is well-formed and refusing it would ignore the whole
    // field and answer with the server's first preference instead.
    if (name !== 'q') continue;

    const parsed = parseQuality(value);
    if (parsed === null) return null;
    quality = parsed;
  }

  return { type, subtype, quality };
}

/**
 * The field as a list of media ranges, or `null` when it is not well-formed.
 *
 * All-or-nothing on purpose. Skipping the members that fail to parse and
 * honouring the rest means a typo in one member silently changes what the other
 * members *mean* — drop the `text/html` a client misspelled and its
 * low-weighted catch-all becomes its first choice — so a field that cannot be
 * read in full is not read at all.
 */
function parseAccept(header: string): MediaRange[] | null {
  const ranges: MediaRange[] = [];

  for (const member of header.split(',')) {
    const trimmed = member.trim();
    // An empty member is legal in the `#` rule — `text/html, , text/plain` —
    // and contributes nothing.
    if (trimmed === '') continue;

    const range = parseMediaRange(trimmed);
    if (range === null) return null;
    ranges.push(range);
  }

  return ranges;
}

/**
 * The server's choice among `offered`, or `null` when nothing offered is
 * acceptable to the client.
 *
 * `offered` is in the server's own preference order, which is what breaks a tie
 * between two equally-acceptable offers.
 *
 * A malformed field is treated as an absent one, which is RFC 9110 §5.5's
 * licence to ignore an invalid field value and the only sane reading here: the
 * alternative is answering 406 for a client's header bug, and a 406 that means
 * "your `Accept` is unparseable" is indistinguishable from the one that means
 * "we have nothing you asked for". One is fixed by the client, the other by the
 * server, and a status that cannot tell them apart sends the investigation to
 * the wrong party. `parseAccept` keeps returning `null` so that a caller
 * needing strictness has the distinction available.
 */
export function selectMediaType(
  header: string | null | undefined,
  offered: readonly string[],
): string | null {
  // RFC 9110 §12.5.1: a request with no `Accept` accepts anything, so the
  // server's first preference wins. `null` is the header-absent case too —
  // `req.headers['accept']` is `undefined`, but a caller reading from a map or
  // a database may hold `null`.
  if (header === null || header === undefined) {
    return offered[0] ?? null;
  }

  const ranges = parseAccept(header);
  if (ranges === null) {
    return offered[0] ?? null;
  }

  let chosen: string | null = null;
  let chosenQuality = 0;

  for (const offer of offered) {
    const parsed = parseMediaRange(offer);
    // An offer this server cannot itself name is not matchable. It is a bug in
    // the caller rather than in the request, so it is skipped rather than
    // throwing on the response path of a live request.
    if (parsed === null) continue;

    const quality = qualityFor(ranges, parsed);
    // `>` and not `>=`: the server's own order is its preference, so the first
    // offer at a given weight keeps it. A zero weight is a refusal, and
    // `chosenQuality` starting at 0 is what excludes it.
    if (quality > chosenQuality) {
      chosen = offer;
      chosenQuality = quality;
    }
  }

  return chosen;
}

/**
 * The weight that applies to one offer: the `q` of the most specific range
 * matching it, or 0 when nothing matches.
 *
 * The *most specific* and deliberately not the highest — that is the whole of
 * §12.5.1's precedence rule, and it is what lets a field say "anything, except
 * HTML". Reading the highest weight among the matches would serve the HTML the
 * client just refused; reading the first match would make the answer depend on
 * the order the client happened to list its ranges in.
 */
function qualityFor(ranges: readonly MediaRange[], offer: MediaRange): number {
  let best: MediaRange | undefined;

  for (const range of ranges) {
    if (!matches(range, offer.type, offer.subtype)) continue;
    if (best === undefined || specificity(range) > specificity(best)) best = range;
  }

  return best?.quality ?? 0;
}
