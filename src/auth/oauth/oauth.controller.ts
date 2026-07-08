import type { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { oauthService } from '@/auth/oauth/oauth.service';
import { AppError } from '@/lib/errors';
import type { OAuthUser } from '@/auth/oauth/oauth.types';

export const oauthController = {
  initiateGoogle(req: Request, res: Response, next: NextFunction): void {
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
  },

  handleGoogleCallback(req: Request, res: Response, next: NextFunction): void {
    passport.authenticate(
      'google',
      { session: false },
      (err: Error | null, user: OAuthUser | false | null) => {
        if (err) return next(err);
        if (!user) return next(new AppError(401, 'Google OAuth failed', 'OAUTH_FAILED'));

        req.session.destroy(() => {
          try {
            const tokens = oauthService.issueTokens(user);
            res.status(200).json({
              data: {
                user: { id: user.id, email: user.email, name: user.name, roles: user.roles },
                ...tokens,
              },
              meta: null,
              error: null,
            });
          } catch (tokenErr) {
            next(tokenErr);
          }
        });
      },
    )(req, res, next);
  },
};
