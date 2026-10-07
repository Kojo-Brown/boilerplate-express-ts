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
