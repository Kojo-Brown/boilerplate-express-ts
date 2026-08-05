export interface JwtPayload {
  userId: string;
  roles: string[];
  type: 'access' | 'refresh';
  /** Unique per token. Two tokens minted in the same second are still distinct. */
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: {
    id: string;
    email: string;
    roles: string[];
  };
  accessToken: string;
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

/** A credential-bearing user, as the auth service needs to see one. */
export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  roles: string[];
}

/**
 * Where the auth service looks users up. Deliberately one method: the service
 * has no business listing, creating or deleting users.
 */
export interface UserDirectory {
  findByEmail(email: string): Promise<AuthUser | null>;
}

/**
 * The refresh-token operations the auth service actually performs.
 *
 * Async even though today's implementation is a `Map`, because the Phase 3
 * DB-backed store will be. A sync signature here would make the interface
 * unimplementable by the thing it exists to allow.
 */
export interface RefreshTokenStore {
  add(token: string, userId: string): Promise<void>;
  has(token: string): Promise<boolean>;
  remove(token: string): Promise<void>;
  removeAllForUser(userId: string): Promise<void>;
}

/**
 * `size()` is an inspection hook for tests and diagnostics. It is kept off
 * `RefreshTokenStore` so no production consumer depends on it and no future
 * implementation is forced to answer a question it may not be able to answer
 * cheaply — a `SELECT count(*)` on every call, say.
 */
export interface InspectableRefreshTokenStore extends RefreshTokenStore {
  size(): number;
}
