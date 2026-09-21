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

/** A refresh token as the store is asked to record it. */
export interface NewRefreshToken {
  token: string;
  userId: string;
  /**
   * The rotation chain this token belongs to. A login starts a family; every
   * rotation extends the same one.
   *
   * Deliberately *not* a claim inside the JWT. A family id in the token would
   * be a value the presenter supplies, and the whole mechanism turns on the
   * server knowing which chain a token really came from — an attacker who can
   * name their own family can put a stolen token in a family of one and the
   * revocation reaches nothing.
   */
  familyId: string;
  /**
   * When this token stops being accepted, in epoch milliseconds, taken from
   * the JWT's own `exp`.
   *
   * It is read off the token rather than configured because the two must agree
   * exactly, and the direction they can disagree in is the dangerous one: a
   * retention window shorter than the token's life is a period where a reused
   * token verifies fine and has no record to recognise it by, which is reuse
   * detection that silently stops detecting.
   */
  expiresAt: number;
}

/**
 * What happened when a refresh token was presented for rotation.
 *
 * Four outcomes and not two, because the interesting ones are the failures and
 * they are not the same failure:
 *
 * - `rotated` — it was live, and is now spent. The caller may mint a successor.
 * - `reuse` — it had *already* been rotated. Someone is presenting a token that
 *   was superseded, which is the signal this whole type exists for: either the
 *   legitimate client is replaying a spent token or an attacker holds a copy,
 *   and the server cannot tell which, so the family dies.
 * - `revoked` — it was explicitly retired by a logout, a logout-everywhere, a
 *   deleted account, or an earlier family revocation. Kept apart from `reuse`
 *   on purpose: this is what a stale client looks like after its user logged
 *   out, it is expected and common, and folding it into `reuse` would fire the
 *   alarm on ordinary behaviour until nobody read it. It also keeps a family
 *   that has already been killed from re-alarming on every further attempt.
 * - `unknown` — never issued here, or issued and since expired past the point
 *   where the JWT itself would still verify.
 */
export type RefreshTokenConsumption =
  | { readonly outcome: 'rotated'; readonly userId: string; readonly familyId: string }
  | { readonly outcome: 'reuse'; readonly userId: string; readonly familyId: string }
  | { readonly outcome: 'revoked'; readonly userId: string; readonly familyId: string }
  | { readonly outcome: 'unknown' };

/**
 * The refresh-token operations the auth service actually performs.
 *
 * Async even though today's implementation is a `Map`, because the Phase 3
 * DB-backed store will be. A sync signature here would make the interface
 * unimplementable by the thing it exists to allow.
 */
export interface RefreshTokenStore {
  /** Records a newly minted token as the live member of its family. */
  issue(record: NewRefreshToken): Promise<void>;

  /**
   * Retires `token` and reports what it was, as one indivisible step.
   *
   * One method rather than a `has()` followed by a `remove()`, and the join is
   * the load-bearing part rather than a tidiness preference. Split in two,
   * every concurrent pair of refreshes carrying the same token can interleave
   * at the `await` between them: both read `active`, both retire it, both mint
   * a successor. That leaves two live tokens in one family — so a chain that is
   * supposed to be linear forks, and the fork is invisible — and it hands an
   * attacker the way around the whole mechanism, since racing the legitimate
   * client is then a reuse that is never reported. Whatever backs this has to
   * make the read and the state change atomic: the `Map` gets it from running
   * both without yielding, Postgres from `UPDATE … WHERE state = 'active'
   * RETURNING …`, where the returned row count *is* the winner test.
   */
  consume(token: string): Promise<RefreshTokenConsumption>;

  /**
   * Retires one token without a successor — a logout.
   *
   * `revoke` rather than `remove`, because the record is kept: a store that
   * forgets a retired token cannot tell a reused one from a token it never
   * issued, and losing that distinction is losing the feature.
   */
  revoke(token: string): Promise<void>;

  /**
   * Revokes every token in one rotation chain, live or spent, and answers with
   * how many it retired. This is the response to a detected reuse.
   */
  revokeFamily(familyId: string): Promise<number>;

  /** Revokes every family belonging to a user — logout-everywhere, or deletion. */
  revokeAllForUser(userId: string): Promise<void>;

  /** Whether `token` would still be accepted for rotation. */
  isActive(token: string): Promise<boolean>;
}

/**
 * `size()` is an inspection hook for tests and diagnostics. It is kept off
 * `RefreshTokenStore` so no production consumer depends on it and no future
 * implementation is forced to answer a question it may not be able to answer
 * cheaply — a `SELECT count(*)` on every call, say.
 */
export interface InspectableRefreshTokenStore extends RefreshTokenStore {
  size(): number;
  /**
   * Drops records whose tokens have expired, and answers with how many went.
   *
   * Retired records are retained until the token's own `exp` and no longer:
   * past that point `verifyRefreshToken` rejects the token before the store is
   * ever consulted, so keeping the record buys no detection and costs memory
   * for a week. Exposed here rather than on `RefreshTokenStore` for the same
   * reason `size()` is — it is housekeeping a DB-backed store would do with a
   * scheduled `DELETE`, not something a caller should have to drive.
   */
  prune(now?: number): number;
}
