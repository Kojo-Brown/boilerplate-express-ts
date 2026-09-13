import type { JwtPayload } from '@/auth/auth.types';
import type { OAuthUser } from '@/auth/oauth/oauth.types';
import type { Scope } from '@/lib/container';

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

      // Optional because the type has to describe a request that has not
      // reached `containerMiddleware` yet — a middleware ahead of it in the
      // chain, or a `Request` built in a test. Handlers read it through
      // `scopeOf`, which turns the absence into one 500 instead of a null
      // check per call site.
      scope?: Scope;

      // The trace this request was served under, copied off the active span by
      // `traceContextMiddleware`. Stored rather than read from the context at
      // the point of use because the one consumer is the access log, and morgan
      // formats its line from an `on-finished` callback — by then the request's
      // context is no longer the active one, and reading the span there yields
      // the trace id of whatever else the process happens to be doing.
      //
      // Absent whenever there is no span: tracing disabled, or an untraced path.
      traceId?: string;
    }
  }
}

export {};
