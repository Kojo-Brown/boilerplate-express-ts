import type { InspectableRefreshTokenStore } from '@/auth/auth.types';

/**
 * In-memory refresh token store. Replaced with a DB-backed store in Phase 3 by
 * handing a different `RefreshTokenStore` to `createAuthService` — no consumer
 * of the service changes.
 *
 * The methods are `async` only to satisfy the interface; the work is synchronous.
 */
export function createInMemoryTokenStore(): InspectableRefreshTokenStore {
  const store = new Map<string, string>(); // token → userId

  return {
    async add(token: string, userId: string): Promise<void> {
      store.set(token, userId);
    },

    async has(token: string): Promise<boolean> {
      return store.has(token);
    },

    async remove(token: string): Promise<void> {
      store.delete(token);
    },

    async removeAllForUser(userId: string): Promise<void> {
      for (const [token, uid] of store.entries()) {
        if (uid === userId) {
          store.delete(token);
        }
      }
    },

    size(): number {
      return store.size;
    },
  };
}

/** Process-wide default instance, wired up in the composition root. */
export const tokenStore: InspectableRefreshTokenStore = createInMemoryTokenStore();
