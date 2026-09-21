import { mockRefreshToken } from '@/auth/refresh-token.fixture';
import { createInMemoryTokenStore } from '@/auth/token-store';
import type { InspectableRefreshTokenStore } from '@/auth/auth.types';

describe('createInMemoryTokenStore', () => {
  let store: InspectableRefreshTokenStore;

  beforeEach(() => {
    store = createInMemoryTokenStore();
  });

  describe('issue / isActive', () => {
    it('accepts a freshly issued token', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a' }));
      await expect(store.isActive('mock-refresh-a')).resolves.toBe(true);
    });

    it('does not know a token it never issued', async () => {
      await expect(store.isActive('mock-refresh-never-issued')).resolves.toBe(false);
    });
  });

  describe('consume', () => {
    it('rotates a live token and reports the family it belonged to', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', familyId: 'family-7' }));

      await expect(store.consume('mock-refresh-a')).resolves.toEqual({
        outcome: 'rotated',
        userId: 'user-1',
        familyId: 'family-7',
      });
    });

    it('leaves a rotated token unusable', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a' }));
      await store.consume('mock-refresh-a');

      await expect(store.isActive('mock-refresh-a')).resolves.toBe(false);
    });

    it('reports the second presentation of a rotated token as reuse', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', familyId: 'family-7' }));
      await store.consume('mock-refresh-a');

      await expect(store.consume('mock-refresh-a')).resolves.toEqual({
        outcome: 'reuse',
        userId: 'user-1',
        familyId: 'family-7',
      });
    });

    it('reports an explicitly revoked token as revoked, not as reuse', async () => {
      // The distinction the alarm depends on. A client that logs out and then
      // retries a refresh with the token it still holds is doing something
      // ordinary; answering `reuse` there would fire the theft signal on
      // everyday behaviour until nobody read it.
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', familyId: 'family-7' }));
      await store.revoke('mock-refresh-a');

      await expect(store.consume('mock-refresh-a')).resolves.toEqual({
        outcome: 'revoked',
        userId: 'user-1',
        familyId: 'family-7',
      });
    });

    it('reports a token it never issued as unknown', async () => {
      await expect(store.consume('mock-refresh-never-issued')).resolves.toEqual({
        outcome: 'unknown',
      });
    });

    it('picks exactly one winner when the same token is consumed concurrently', async () => {
      // The property the single `consume` call exists for. Split into a
      // `has()` then a `remove()`, both of these interleave at the `await`
      // between them, both see a live token, and both rotate it — which forks
      // the chain and, worse, means racing the legitimate client is a reuse
      // that never gets reported.
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a' }));

      const outcomes = (
        await Promise.all([store.consume('mock-refresh-a'), store.consume('mock-refresh-a')])
      ).map((result) => result.outcome);

      expect(outcomes.filter((outcome) => outcome === 'rotated')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'reuse')).toHaveLength(1);
    });
  });

  describe('revokeFamily', () => {
    it('revokes every member of the family, live and spent alike', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', familyId: 'family-7' }));
      await store.issue(mockRefreshToken({ token: 'mock-refresh-b', familyId: 'family-7' }));
      await store.consume('mock-refresh-a'); // now spent

      await expect(store.revokeFamily('family-7')).resolves.toBe(2);

      await expect(store.isActive('mock-refresh-b')).resolves.toBe(false);
      // The spent one is now `revoked` rather than `rotated`, so a further
      // presentation does not re-fire the alarm for a family already dead.
      await expect(store.consume('mock-refresh-a')).resolves.toMatchObject({
        outcome: 'revoked',
      });
    });

    it('leaves other families alone', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', familyId: 'family-7' }));
      await store.issue(mockRefreshToken({ token: 'mock-refresh-b', familyId: 'family-8' }));

      await store.revokeFamily('family-7');

      await expect(store.isActive('mock-refresh-b')).resolves.toBe(true);
    });

    it('counts nothing for a family that was already revoked', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', familyId: 'family-7' }));
      await store.revokeFamily('family-7');

      await expect(store.revokeFamily('family-7')).resolves.toBe(0);
    });

    it('counts nothing for a family that does not exist', async () => {
      await expect(store.revokeFamily('family-does-not-exist')).resolves.toBe(0);
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes every family the user holds', async () => {
      await store.issue(
        mockRefreshToken({ token: 'mock-refresh-a', userId: 'user-1', familyId: 'family-7' }),
      );
      await store.issue(
        mockRefreshToken({ token: 'mock-refresh-b', userId: 'user-1', familyId: 'family-8' }),
      );
      await store.issue(mockRefreshToken({ token: 'mock-refresh-c', userId: 'user-2' }));

      await store.revokeAllForUser('user-1');

      await expect(store.isActive('mock-refresh-a')).resolves.toBe(false);
      await expect(store.isActive('mock-refresh-b')).resolves.toBe(false);
      await expect(store.isActive('mock-refresh-c')).resolves.toBe(true);
    });

    it('leaves the revoked tokens recognisable rather than forgotten', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', userId: 'user-1' }));

      await store.revokeAllForUser('user-1');

      await expect(store.consume('mock-refresh-a')).resolves.toMatchObject({
        outcome: 'revoked',
      });
    });
  });

  describe('expiry', () => {
    it('treats a record past its expiry as absent', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a', expiresAt: Date.now() - 1 }));

      await expect(store.isActive('mock-refresh-a')).resolves.toBe(false);
      await expect(store.consume('mock-refresh-a')).resolves.toEqual({ outcome: 'unknown' });
    });

    it('remembers a retired token for as long as the token itself verifies', async () => {
      // The invariant that keeps detection from silently lapsing: retention is
      // the token's own `exp`, so there is no window in which a reused token
      // passes `verifyRefreshToken` and has no record left to recognise it by.
      await store.issue(
        mockRefreshToken({ token: 'mock-refresh-a', expiresAt: Date.now() + 60_000 }),
      );
      await store.consume('mock-refresh-a');

      await expect(store.consume('mock-refresh-a')).resolves.toMatchObject({ outcome: 'reuse' });
    });

    it('drops expired records on prune and keeps live ones', async () => {
      await store.issue(mockRefreshToken({ token: 'mock-refresh-old', expiresAt: Date.now() - 1 }));
      await store.issue(
        mockRefreshToken({ token: 'mock-refresh-new', expiresAt: Date.now() + 60_000 }),
      );

      expect(store.prune()).toBe(1);
      expect(store.size()).toBe(1);
      await expect(store.isActive('mock-refresh-new')).resolves.toBe(true);
    });

    it('does not count a family member that has already expired', async () => {
      await store.issue(
        mockRefreshToken({
          token: 'mock-refresh-old',
          familyId: 'family-7',
          expiresAt: Date.now() - 1,
        }),
      );
      await store.issue(mockRefreshToken({ token: 'mock-refresh-new', familyId: 'family-7' }));

      await expect(store.revokeFamily('family-7')).resolves.toBe(1);
      expect(store.size()).toBe(1);
    });
  });

  describe('isolation', () => {
    it('gives each instance its own records', async () => {
      const other = createInMemoryTokenStore();
      await store.issue(mockRefreshToken({ token: 'mock-refresh-a' }));

      await expect(other.isActive('mock-refresh-a')).resolves.toBe(false);
      expect(other.size()).toBe(0);
    });
  });
});
