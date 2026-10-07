import { selectMediaType } from '@/http/accept';

/**
 * Cycle 1 — the degenerate case: one offer, and a field that either names it or
 * does not. No wildcards, no weights, no parameters.
 */
describe('selectMediaType — exact media types', () => {
  it('chooses the offer the client named', () => {
    expect(selectMediaType('application/json', ['application/json'])).toBe('application/json');
  });

  it('chooses nothing when the client named something else', () => {
    expect(selectMediaType('text/html', ['application/json'])).toBeNull();
  });

  /**
   * RFC 9110 §12.5.1: "A request without any Accept header field implies that
   * the user agent will accept any media type in response." Absent is not the
   * same as empty-handed — it is the widest possible field, so the server's own
   * first preference wins.
   */
  it('treats an absent field as no constraint at all', () => {
    expect(selectMediaType(undefined, ['application/json'])).toBe('application/json');
    expect(selectMediaType(null, ['application/json'])).toBe('application/json');
  });

  /** Media types are case-insensitive (RFC 9110 §8.3.1). */
  it('matches without regard to case on either side', () => {
    expect(selectMediaType('APPLICATION/JSON', ['application/json'])).toBe('application/json');
    expect(selectMediaType('application/json', ['APPLICATION/JSON'])).toBe('APPLICATION/JSON');
  });

  /** The offer is echoed back exactly as the caller spelled it, not normalised. */
  it('returns the offer as the caller spelled it', () => {
    expect(selectMediaType('text/plain', ['Text/Plain'])).toBe('Text/Plain');
  });
});

/**
 * Cycle 2 — the field is a list of *media ranges*, not a media type, and a
 * range may be `type/*` or the full wildcard. Where two ranges match one offer, the more
 * specific one is the one that speaks for it (RFC 9110 §12.5.1) — which matters
 * only once weights arrive in cycle 3, but the ordering is what decides *which*
 * weight applies, so it is established here.
 */
describe('selectMediaType — lists and wildcards', () => {
  it('reads the field as a list rather than as one media type', () => {
    expect(selectMediaType('text/html, application/json', ['application/json'])).toBe(
      'application/json',
    );
  });

  it('tolerates the whitespace a real client sends around members', () => {
    expect(selectMediaType('  text/html ,\tapplication/json  ', ['application/json'])).toBe(
      'application/json',
    );
  });

  it('matches any subtype under a type wildcard', () => {
    expect(selectMediaType('image/*', ['image/png'])).toBe('image/png');
    expect(selectMediaType('image/*', ['application/pdf'])).toBeNull();
  });

  it('matches anything at all under */*', () => {
    expect(selectMediaType('*/*', ['application/pdf'])).toBe('application/pdf');
  });

  /**
   * The server's order is its preference, so with everything equally acceptable
   * the first offer wins. A client that wants to express a preference has
   * weights for it.
   */
  it('prefers the server’s own order when the client is indifferent', () => {
    expect(selectMediaType('*/*', ['application/json', 'text/csv'])).toBe('application/json');
    expect(selectMediaType('*/*', ['text/csv', 'application/json'])).toBe('text/csv');
  });

  // A wildcard type paired with a real subtype is not in the grammar.
  // Admitting it would make `*/json` mean something this parser invented, so
  // the member is not well-formed and the whole field is ignored — the policy
  // cycle 3 pins down. (Written as a line comment, not a block one: the literal
  // closes a block comment, and the zero-width space an earlier draft used to
  // hide that left an invisible character in the source.)
  it('does not invent a subtype-only wildcard', () => {
    expect(selectMediaType('*/json', ['application/json'])).toBe('application/json');
    expect(selectMediaType('*/json', ['text/csv'])).toBe('text/csv');
  });

  /** An empty field is a field, and it is the one that accepts nothing. */
  it('accepts nothing for an empty field', () => {
    expect(selectMediaType('', ['application/json'])).toBeNull();
  });

  it('chooses nothing when there is nothing to choose from', () => {
    expect(selectMediaType('*/*', [])).toBeNull();
  });
});

/**
 * Cycle 3 — weights (RFC 9110 §12.4.2). `q` is the client's relative
 * preference, `q=0` is a refusal, and the weight that applies to an offer is
 * the one on the *most specific* range matching it — which is what makes
 * cycle 2's `specificity()` load-bearing.
 */
describe('selectMediaType — weights', () => {
  it('prefers the offer the client weighted highest, not the one it listed first', () => {
    expect(
      selectMediaType('application/json;q=0.3, text/csv;q=0.9', ['application/json', 'text/csv']),
    ).toBe('text/csv');
  });

  /** A member with no `q` is `q=1`, the maximum. */
  it('treats a missing weight as the strongest preference', () => {
    expect(selectMediaType('application/json;q=0.9, text/csv', ['application/json', 'text/csv'])).toBe(
      'text/csv',
    );
  });

  it('keeps the server’s order when two offers are weighted alike', () => {
    expect(
      selectMediaType('application/json;q=0.5, text/csv;q=0.5', ['application/json', 'text/csv']),
    ).toBe('application/json');
  });

  /**
   * `q=0` means "not acceptable" (§12.4.2), so it excludes rather than
   * deprioritises. An offer left with only a zero-weighted match is as
   * unavailable as one with no match at all.
   */
  it('refuses an offer weighted zero', () => {
    expect(selectMediaType('application/json;q=0', ['application/json'])).toBeNull();
    expect(selectMediaType('application/json;q=0.000', ['application/json'])).toBeNull();
  });

  /**
   * The exclusion that only works if the *narrower* range wins: "anything,
   * except HTML". Taking the first match, or the highest weight among matches,
   * would serve the HTML the client just refused.
   */
  it('lets a narrow refusal override a broad acceptance', () => {
    expect(selectMediaType('*/*, text/html;q=0', ['text/html', 'application/json'])).toBe(
      'application/json',
    );
    expect(selectMediaType('text/*, text/html;q=0', ['text/html'])).toBeNull();
  });

  /** And the same precedence in the other direction: a narrow yes under a broad no. */
  it('lets a narrow acceptance override a broad refusal', () => {
    expect(selectMediaType('*/*;q=0, application/json', ['application/json'])).toBe(
      'application/json',
    );
  });

  /** The browser field, which is this parser's real caller. */
  it('reads a browser’s field', () => {
    const chrome =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
    expect(selectMediaType(chrome, ['application/json'])).toBe('application/json');
    expect(selectMediaType(chrome, ['application/json', 'text/html'])).toBe('text/html');
  });

  /** A scraper's field, where the narrow preference is the whole point. */
  it('reads a Prometheus scraper’s field', () => {
    const prometheus =
      'application/openmetrics-text;version=1.0.0;q=0.75,' +
      'text/plain;version=0.0.4;q=0.5,*/*;q=0.1';
    expect(
      selectMediaType(prometheus, ['text/plain', 'application/openmetrics-text']),
    ).toBe('application/openmetrics-text');
  });

  /**
   * `qvalue` is `0`–`1` with at most three decimals. Anything else is not a
   * weight, which makes the member malformed and the field ignored — so these
   * answer with the first offer rather than with a reading of a `q` nobody
   * specified.
   */
  it('refuses to guess at a weight outside the grammar', () => {
    for (const bad of ['q=1.5', 'q=-0.5', 'q=0.1234', 'q=abc', 'q=', 'q=.5']) {
      expect(selectMediaType(`application/json;${bad}`, ['text/csv', 'application/json'])).toBe(
        'text/csv',
      );
    }
  });

  it('accepts every weight the grammar does admit', () => {
    for (const ok of ['q=1', 'q=1.0', 'q=1.000', 'q=0.5', 'q=0.25', 'q=0.125']) {
      expect(selectMediaType(`application/json;${ok}`, ['application/json'])).toBe(
        'application/json',
      );
    }
  });

  /** `q` is a parameter name, and parameter names are case-insensitive. */
  it('reads the weight regardless of the case of its name', () => {
    expect(selectMediaType('application/json;Q=0', ['application/json'])).toBeNull();
  });

  it('tolerates whitespace around the parameter delimiters', () => {
    expect(selectMediaType('application/json ; q=0', ['application/json'])).toBeNull();
    expect(selectMediaType('application/json;q = 0', ['application/json'])).toBeNull();
  });
});

/**
 * Cycle 4 — media type parameters. Two things they do, and the naive splitter
 * gets both wrong.
 *
 * They refine specificity: `text/plain;format=flowed` is more specific than
 * `text/plain`, so a weight on the parameterised range is the one that speaks
 * for an offer carrying that parameter (RFC 9110 §12.5.1). And a parameter
 * value may be a quoted string, which may contain a `;` or a `,` — the two
 * characters the list and parameter splitters key on.
 */
describe('selectMediaType — media type parameters', () => {
  it('matches a parameterised range only against an offer that carries the parameter', () => {
    expect(selectMediaType('text/plain;format=flowed', ['text/plain;format=flowed'])).toBe(
      'text/plain;format=flowed',
    );
    expect(selectMediaType('text/plain;format=flowed', ['text/plain'])).toBeNull();
  });

  /** A range with no parameters is the broader one, and still matches. */
  it('matches a bare range against a parameterised offer', () => {
    expect(selectMediaType('text/plain', ['text/plain;charset=utf-8'])).toBe(
      'text/plain;charset=utf-8',
    );
  });

  /**
   * The precedence that only works if a parameter counts toward specificity:
   * "any plain text, but not the flowed kind".
   */
  it('lets a parameterised refusal override a bare acceptance', () => {
    expect(
      selectMediaType('text/plain, text/plain;format=flowed;q=0', [
        'text/plain;format=flowed',
        'text/plain',
      ]),
    ).toBe('text/plain');
  });

  it('reads the scraper’s version parameter as the preference it is', () => {
    const field = 'text/plain;version=0.0.4;q=0.3, text/plain;version=1.0.0;q=0.9';
    expect(
      selectMediaType(field, ['text/plain;version=0.0.4', 'text/plain;version=1.0.0']),
    ).toBe('text/plain;version=1.0.0');
  });

  /** Parameter names fold case; values do not (RFC 9110 §8.3.1). */
  it('folds the case of a parameter’s name but not of its value', () => {
    expect(selectMediaType('text/plain;Format=flowed', ['text/plain;format=flowed'])).toBe(
      'text/plain;format=flowed',
    );
    expect(selectMediaType('text/plain;format=FLOWED', ['text/plain;format=flowed'])).toBeNull();
  });

  /**
   * A quoted value is equivalent to its unquoted form when the contents are a
   * token, so the two spellings must match each other.
   */
  it('reads a quoted parameter value as the token it quotes', () => {
    expect(selectMediaType('text/plain;format="flowed"', ['text/plain;format=flowed'])).toBe(
      'text/plain;format=flowed',
    );
  });

  /**
   * The case `header.split(',')` cannot survive: a comma inside a quoted value
   * is data, not a list separator. Split on it and this one field becomes two
   * malformed members — which, under the all-or-nothing policy, silently
   * discards a field the client wrote correctly.
   */
  it('does not split a list on a comma inside a quoted value', () => {
    expect(selectMediaType('text/plain;note="a,b"', ['text/plain;note=a,b'])).toBeNull();
    expect(selectMediaType('text/plain;note="a,b"', ['text/plain;note="a,b"'])).toBe(
      'text/plain;note="a,b"',
    );
  });

  /** And the same for `;`, which `member.split(';')` keys on. */
  it('does not split parameters on a semicolon inside a quoted value', () => {
    expect(selectMediaType('text/plain;note="a;b";q=0', ['text/plain;note="a;b"'])).toBeNull();
    expect(selectMediaType('text/plain;note="a;b"', ['text/plain;note="a;b"'])).toBe(
      'text/plain;note="a;b"',
    );
  });

  /** A backslash escape inside a quoted string is part of the grammar too. */
  it('reads a quoted-pair inside a quoted value', () => {
    expect(selectMediaType('text/plain;note="a\\"b"', ['text/plain;note="a\\"b"'])).toBe(
      'text/plain;note="a\\"b"',
    );
  });

  /** An unterminated quoted string is malformed, so the field is ignored. */
  it('ignores a field whose quoted value never closes', () => {
    expect(selectMediaType('text/plain;note="unclosed', ['text/csv', 'text/plain'])).toBe(
      'text/csv',
    );
  });

  /**
   * A repeated parameter has no defined meaning — the first and the last reading
   * disagree about what was asked for, and the sender picks which — so the
   * member is malformed rather than resolved.
   */
  it('refuses a member that names one parameter twice', () => {
    expect(selectMediaType('text/plain;format=flowed;format=fixed', ['text/csv', 'text/plain'])).toBe(
      'text/csv',
    );
  });

  /** Two members may specify the same media type with different parameters. */
  it('keeps parameterised members distinct from one another', () => {
    expect(
      selectMediaType('text/plain;a=1;q=0.2, text/plain;a=2;q=0.8', [
        'text/plain;a=1',
        'text/plain;a=2',
      ]),
    ).toBe('text/plain;a=2');
  });
});
