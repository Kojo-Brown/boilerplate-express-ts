// In-memory refresh token store. Replaced with DB-backed store in Phase 3.
const store = new Map<string, string>(); // token → userId

export const tokenStore = {
  add(token: string, userId: string): void {
    store.set(token, userId);
  },

  has(token: string): boolean {
    return store.has(token);
  },

  remove(token: string): void {
    store.delete(token);
  },

  removeAllForUser(userId: string): void {
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
