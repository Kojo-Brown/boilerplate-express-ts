import { generateCodeVerifier, generateCodeChallenge, verifyChallenge } from '@/auth/oauth/pkce';

describe('generateCodeVerifier', () => {
  it('returns a base64url string of at least 43 characters', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('produces unique values on each call', () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(v1).not.toBe(v2);
  });
});

describe('generateCodeChallenge', () => {
  it('returns a base64url string', () => {
    const challenge = generateCodeChallenge(generateCodeVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('is deterministic for the same verifier', () => {
    const verifier = generateCodeVerifier();
    expect(generateCodeChallenge(verifier)).toBe(generateCodeChallenge(verifier));
  });

  it('produces different challenges for different verifiers', () => {
    const c1 = generateCodeChallenge(generateCodeVerifier());
    const c2 = generateCodeChallenge(generateCodeVerifier());
    expect(c1).not.toBe(c2);
  });
});

describe('verifyChallenge', () => {
  it('returns true when verifier matches challenge', () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    expect(verifyChallenge(verifier, challenge)).toBe(true);
  });

  it('returns false when verifier does not match challenge', () => {
    const verifier1 = generateCodeVerifier();
    const verifier2 = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier1);
    expect(verifyChallenge(verifier2, challenge)).toBe(false);
  });

  it('returns false for a tampered challenge', () => {
    const verifier = generateCodeVerifier();
    expect(verifyChallenge(verifier, 'invalid-challenge')).toBe(false);
  });
});
