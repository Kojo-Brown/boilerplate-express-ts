/**
 * `@types/passport` owns `Express.Request.user` and declares it as
 * `Express.User | undefined`. Redeclaring `user` on `Request` collides with
 * that declaration (TS2717), so widening `Express.User` is the supported
 * extension point and the single place this app does it.
 *
 * Two principals flow through `Express.User`:
 *
 * - the `JwtPayload` that `requireAuth` attaches after verifying a bearer
 *   token, and
 * - the `OAuthUser` that passport hands to the Google strategy's verify
 *   callback.
 *
 * `roles` is the contract both satisfy, so it is required. The identity
 * fields are optional because each principal carries only its own: consumers
 * that need `userId` should read it behind `requireAuth`, where the JWT
 * payload is what populated the request.
 */
declare global {
  namespace Express {
    interface User {
      roles: string[];
      userId?: string;
      type?: 'access' | 'refresh';
    }
  }
}

export {};
