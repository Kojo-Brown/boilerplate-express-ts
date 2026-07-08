import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { env } from '@/config/env';
import { oauthService } from '@/auth/oauth/oauth.service';

export function registerGoogleStrategy(): void {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: env.GOOGLE_CALLBACK_URL,
        pkce: true,
        state: true,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const user = await oauthService.upsertGoogleUser({
            id: profile.id,
            displayName: profile.displayName,
            email: profile.emails?.[0]?.value,
            picture: profile.photos?.[0]?.value ?? null,
          });
          done(null, user);
        } catch (err) {
          done(err as Error);
        }
      },
    ),
  );
}
