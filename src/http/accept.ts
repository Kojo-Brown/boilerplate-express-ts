/**
 * Proactive content negotiation for `Accept` (RFC 9110 §12.5.1).
 *
 * Built red→green→refactor; the cycles and what each one found are in
 * `docs/tdd-kata.md`.
 *
 * Kept here with `entity-tag`, `range` and `retry-after` rather than next to a
 * route, for the same reason those are: it takes a string and a list of strings
 * and returns one of them, so every case in the grammar is cheap to write down
 * and nothing about it needs a socket. A caller's own tests are then about what
 * it *does* with the answer.
 *
 * A note on these comments: the full wildcard media range is written
 * "star-slash-star" in prose, never as the literal, because the literal closes
 * a block comment. An earlier draft smuggled a zero-width space into it, which
 * compiled and left an invisible character in a media range a reader would copy
 * out of the source.
 */

/**
 * A media type: the half of the grammar both sides of the negotiation share.
 *
 * Either half may be `*` in a client's range and neither may be in a server's
 * offer, which is not expressible in a type — see `parseOffer`.
 */
interface MediaType {
  readonly type: string;
  readonly subtype: string;
  /**
   * The type's own parameters, `q` excluded: lowercased names, values as
   * written once any quoting is removed.
   *
   * `q` is deliberately not among them. RFC 9110 §12.4.2 puts the weight
   * *after* the media range rather than inside it, so a range that kept `q` as
   * a parameter would count the client's preference as part of the thing being
   * preferred — and `text/plain;q=0.5` would stop matching an offer of
   * `text/plain`.
   */
  readonly parameters: ReadonlyMap<string, string>;
}

/** A media type as the client wrote it: with a weight, and wildcards allowed. */
interface MediaRange extends MediaType {
  /** The member's `q`, defaulted to 1. `0` is a refusal, not a low ranking. */
  readonly quality: number;
}

/**
 * How specific a range is, so that the one which *speaks for* an offer can be
 * picked out of the several that match it: `text/plain;format=flowed` over
 * `text/plain` over `text/*` over star-slash-star. Only the winner's weight
 * counts, which is what makes a field pairing a broad `q=1` with a narrow `q=0`
 * a refusal rather than a tie.
 *
 * Parameters rank above the type/subtype halves rather than beside them,
 * because a parameterised range is a subset of the bare range it extends and so
 * is always the narrower statement. Their count is added rather than compared
 * separately, which is safe here: two ranges that match the same offer can
 * differ in parameter count only if one names a superset of the other's.
 */
function specificity(range: MediaRange): number {
  if (range.type === '*') return 0;
  if (range.subtype === '*') return 1;
  return 2 + range.parameters.size;
}

function matches(range: MediaRange, offer: MediaType): boolean {
  if (range.type !== '*') {
    if (range.type !== offer.type) return false;
    if (range.subtype !== '*' && range.subtype !== offer.subtype) return false;
  }

  // Every parameter the range names must be on the offer with the same value.
  // The converse is not required: a bare range is the broader statement, and it
  // matches an offer that carries parameters of its own.
  for (const [name, value] of range.parameters) {
    if (offer.parameters.get(name) !== value) return false;
  }

  return true;
}

/**
 * `tchar` (RFC 9110 §5.6.2). The delimiters are what matter here: `,` `;` `/`
 * `"` `=` and whitespace are all excluded, which is what makes an unquoted
 * value carrying one of them *malformed* rather than a value with a surprising
 * character in it.
 *
 * Without this check `text/plain;note=a,b` parses: the list splitter has
 * already cut the field at that comma, so each half arrives looking plausible
 * and the parser reconstructs a parameter value the sender never wrote. A comma
 * in a value has to be quoted, and the point of validating is that the two
 * spellings stop being interchangeable.
 */
function isToken(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

/**
 * `qvalue` from RFC 9110 §12.4.2: `0`–`1`, at most three decimals, no sign and
 * no exponent. `null` for anything else, which makes the member malformed.
 *
 * Strict because the lenient version silently invents a preference. `Number()`
 * reads `1.5` as 1.5, `-0.5` as a negative, `1e-3` as 0.001 and `''` as 0 — and
 * that last one turns a client's typo into a refusal of the very thing it asked
 * for, which is the worst answer available.
 */
function parseQuality(value: string): number | null {
  if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(value)) return null;
  return Number(value);
}

/**
 * Splits a field on a delimiter, ignoring the ones inside a quoted string.
 *
 * This is why the parser is not two `String.split` calls. A parameter value may
 * be a `quoted-string` (§5.6.4), a quoted string may contain `,` and `;`, and
 * those are exactly the characters the list and parameter grammars key on — so
 * `Accept: text/plain;note="a,b"` is one well-formed member that splitting
 * tears into two malformed ones. Under the all-or-nothing policy below that
 * discards the whole field, so a correct request is misread as an absent one
 * and nothing anywhere reports it.
 *
 * `null` for an unterminated quoted string, which must not be guessed at: the
 * two available readings — take the rest as data, or close the quote at the end
 * of the field — disagree about where the member ends.
 */
function splitUnquoted(field: string, delimiter: ',' | ';'): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;

  for (let i = 0; i < field.length; i++) {
    const char = field[i];

    if (quoted) {
      // A quoted-pair escapes the next octet, the closing quote included, so
      // the escaped character is stepped over rather than examined.
      if (char === '\\') i++;
      else if (char === '"') quoted = false;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === delimiter) {
      parts.push(field.slice(start, i));
      start = i + 1;
    }
  }

  if (quoted) return null;

  parts.push(field.slice(start));
  return parts;
}

/**
 * A parameter value: a bare token, or a quoted string with its quotes removed
 * and its quoted-pairs unescaped.
 *
 * The two spellings are equivalent when the contents are a token (§5.6.6), so
 * unquoting here is what makes `format="flowed"` match `format=flowed` rather
 * than being a value that merely looks like it.
 */
function parseParameterValue(raw: string): string | null {
  if (!raw.startsWith('"')) return isToken(raw) ? raw : null;

  let value = '';

  for (let i = 1; i < raw.length; i++) {
    const char = raw[i];

    if (char === '\\') {
      const escaped = raw[i + 1];
      if (escaped === undefined) return null;
      value += escaped;
      i++;
      continue;
    }

    if (char === '"') {
      // Trailing junk after the closing quote — `"a"b` — is not a value.
      return i === raw.length - 1 ? value : null;
    }

    value += char;
  }

  return null;
}

/**
 * One media range: `type/subtype` lowercased, with its parameters and weight.
 * `null` when it is not that shape.
 *
 * Also the parser for a server *offer*, which is the asymmetry this signature
 * hides and `parseOffer` names: an offer is a media type this service can
 * actually produce, so a wildcard in it means nothing and a weight in it is
 * the client's vocabulary in the server's mouth. Both are currently parsed and
 * then ignored.
 */
function parseMediaRange(member: string): MediaRange | null {
  const segments = splitUnquoted(member, ';');
  if (segments === null) return null;

  const [mediaType, ...rest] = segments;
  if (mediaType === undefined) return null;

  const slash = mediaType.indexOf('/');
  if (slash === -1) return null;

  const type = mediaType.slice(0, slash).trim().toLowerCase();
  const subtype = mediaType.slice(slash + 1).trim().toLowerCase();
  // `*` is not a `tchar`, so each half is either the wildcard or a token. This
  // also subsumes the "no second slash" and "not empty" checks, since `/` is a
  // delimiter and a token has at least one character.
  if (!(type === '*' || isToken(type))) return null;
  if (!(subtype === '*' || isToken(subtype))) return null;

  // A wildcard type pairs only with a wildcard subtype: `*/json` is not in the
  // grammar, and admitting it would give it a meaning this parser invented,
  // which no other server would agree with.
  if (type === '*' && subtype !== '*') return null;

  let quality = 1;
  let weightSeen = false;
  const parameters = new Map<string, string>();

  for (const segment of rest) {
    const equals = segment.indexOf('=');
    if (equals === -1) return null;

    const name = segment.slice(0, equals).trim().toLowerCase();
    const raw = segment.slice(equals + 1).trim();
    if (!isToken(name)) return null;

    if (name === 'q') {
      const parsed = parseQuality(raw);
      if (parsed === null) return null;
      // One weight per range: two disagree about the preference, and picking
      // between them is a decision made on the sender's behalf.
      if (weightSeen) return null;
      quality = parsed;
      weightSeen = true;
      continue;
    }

    // Everything after the weight is `accept-ext` (§12.4.2) and not a media
    // type parameter. Nothing here defines an extension, so they are accepted
    // and left out of the parameter set — counted, they would let an extension
    // outrank the parameterised range it follows.
    if (weightSeen) continue;

    const value = parseParameterValue(raw);
    if (value === null) return null;
    // A repeated parameter has no defined meaning: first-wins and last-wins
    // disagree about what was asked for, and the sender picks which.
    if (parameters.has(name)) return null;
    parameters.set(name, value);
  }

  return { type, subtype, quality, parameters };
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
  const members = splitUnquoted(header, ',');
  if (members === null) return null;

  const ranges: MediaRange[] = [];

  for (const member of members) {
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
 * One entry of the caller's `offered` list, as a media type.
 *
 * A separate function from `parseMediaRange` with, for now, exactly the same
 * body — the split is the point. The two strings are read by the same grammar
 * and judged by different rules: a range is what a client will accept, so a
 * wildcard and a weight both belong in it, while an offer is a representation
 * this service can produce, where a wildcard names nothing and a weight is the
 * client's vocabulary in the server's mouth. Sharing one parser left both
 * accepted and silently ignored, which is visible here and nowhere else.
 */
function parseOffer(offer: string): MediaType | null {
  return parseMediaRange(offer);
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
function qualityFor(ranges: readonly MediaRange[], offer: MediaType): number {
  let best: MediaRange | undefined;

  for (const range of ranges) {
    if (!matches(range, offer)) continue;
    if (best === undefined || specificity(range) > specificity(best)) best = range;
  }

  return best?.quality ?? 0;
}

/**
 * The server's choice among `offered`, or `null` when nothing offered is
 * acceptable to the client.
 *
 * `offered` is in the server's own preference order, which is what breaks a tie
 * between two equally-acceptable offers. Each entry is a media type the caller
 * can actually produce, parameters included — `text/plain;version=0.0.4` is a
 * different offer from `text/plain`, and both may be listed.
 *
 * A malformed field is treated as an absent one, which is §5.5's licence to
 * ignore an invalid field value and the only sane reading here: the alternative
 * answers 406 for a client's header bug, and a 406 meaning "your `Accept` is
 * unparseable" is indistinguishable from the one meaning "we have nothing you
 * asked for". One is fixed by the client and the other by the server, and a
 * status that cannot tell them apart sends the investigation to the wrong party.
 */
export function selectMediaType(
  header: string | null | undefined,
  offered: readonly string[],
): string | null {
  // §12.5.1: a request with no `Accept` accepts anything, so the server's first
  // preference wins. `null` is the absent case too — `req.headers['accept']` is
  // `undefined`, but a caller reading from a map or a database may hold `null`.
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
    const parsed = parseOffer(offer);
    // An offer this server cannot itself name is not matchable. That is a bug
    // in the caller rather than in the request, so it is skipped rather than
    // thrown on the response path of a live request.
    if (parsed === null) continue;

    const quality = qualityFor(ranges, parsed);
    // `>` and not `>=`: the server's order is its preference, so the first
    // offer at a given weight keeps it. A zero weight is a refusal, and
    // `chosenQuality` starting at 0 is what excludes it — a refusal needs no
    // branch of its own.
    if (quality > chosenQuality) {
      chosen = offer;
      chosenQuality = quality;
    }
  }

  return chosen;
}
