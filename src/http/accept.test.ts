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
