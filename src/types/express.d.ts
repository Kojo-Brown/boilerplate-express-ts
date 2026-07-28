import type { JwtPayload } from '@/auth/auth.types';
import type { OAuthUser } from '@/auth/oauth/oauth.types';

declare global {
  namespace Express {
    // `@types/passport` owns `Request.user` and types it as `Express.User`, the
    // principal a strategy hands to `done()`. Here that is always the upserted
    // OAuth user, so the augmentation belongs on `User` rather than on `Request`.
    interface User extends OAuthUser {}

    // The bearer-token principal is a different shape and a different lifecycle
    // from passport's, so `requireAuth` publishes it on its own property —
    // the same split express-jwt uses.
    interface Request {
      auth?: JwtPayload;
    }
  }
}

export {};
