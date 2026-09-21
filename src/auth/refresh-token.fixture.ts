import type { NewRefreshToken } from '@/auth/auth.types';

/**
 * Builds a `NewRefreshToken` for suites that exercise the store directly.
 *
 * Shared rather than repeated in each suite because of `expiresAt`: it is the
 * one field with a wrong default that would not look wrong. Left at `0`, or at
 * a timestamp copied from a neighbouring test, every record is born expired
 * and the store treats it as absent — which makes `isActive` return `false`,
 * `consume` return `unknown` and a revocation count come back `0`. Those are
 * exactly the answers a passing revocation test expects, so the suite stays
 * green while asserting nothing.
 *
 * `*.fixture.ts` is excluded from `tsconfig.build.json` alongside `*.test.ts`,
 * so none of this reaches `dist/`, and it is still typechecked because
 * `pnpm typecheck` runs over all of `src`.
 */
export function mockRefreshToken(overrides: Partial<NewRefreshToken> = {}): NewRefreshToken {
  return {
    token: 'mock-refresh-token',
    userId: 'user-1',
    familyId: 'family-1',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}
