/**
 * A JWT-shaped string for the suites that exercise the JWT detector.
 *
 * Assembled at runtime rather than pasted in as a literal, which is the whole
 * reason this file exists. The detector's trigger is the token's *shape* —
 * three base64url segments whose first begins `eyJ` — and that is exactly the
 * shape every secret scanner looks for, so a fixture written out in full fails
 * a scan on both files that need one. It failed GitGuardian on the commit that
 * introduced it.
 *
 * Nothing about it is sensitive: the header is `{"alg":"HS256"}`, the payload
 * is `{"sub":"mock"}` and the signature says in words that it is not one.
 * Writing it as its parts rather than as twenty opaque characters also says
 * that on the page, which the literal never managed to.
 *
 * `*.fixture.ts` is excluded from `tsconfig.build.json` alongside `*.test.ts`,
 * so none of this reaches `dist/`, and it is still typechecked because
 * `pnpm typecheck` runs over all of `src`.
 */
function base64url(segment: object): string {
  return Buffer.from(JSON.stringify(segment)).toString('base64url');
}

export const FAKE_JWT = [
  base64url({ alg: 'HS256' }),
  base64url({ sub: 'mock' }),
  'mock-signature-not-a-real-one',
].join('.');
