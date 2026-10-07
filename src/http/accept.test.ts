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
