import type { Request, Response, NextFunction } from 'express';
import { authService } from '@/auth/auth.service';
import { authStrategyRegistry, magicLinkIssuer } from '@/auth/strategies';
import { AppError } from '@/lib/errors';
import { sendAccepted, sendOk, sendNoContent } from '@/lib/response';
import type { LoginBody, LogoutBody, MagicLinkRequestBody, RefreshBody } from '@/auth/auth.schemas';

type BodyOf<T> = Request<Record<string, string>, unknown, T>;

/** `POST /v1/auth/login/:strategy` — body shape is the strategy's business. */
type StrategyLoginRequest = Request<{ strategy: string }, unknown, unknown>;

/**
 * Transport only: call the service, shape the response, hand errors to the
 * error middleware. Bodies arrive already parsed by `validate()` on the router,
 * except on `/login/:strategy`, where the schema is not knowable until the
 * strategy has been resolved and parsing therefore happens inside it.
 */
export const authController = {
  async login(req: BodyOf<LoginBody>, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.login(req.body);
      sendOk(res, result);
    } catch (err) {
      next(err);
    }
  },

  /**
   * Login through any registered strategy.
   *
   * The segment is narrowed with the registry's `has()` rather than handed to
   * `resolveUnknown`, whose `UnknownProviderError` is a 500 by design — that
   * status is right for a misconfigured `STORAGE_DRIVER`, which the caller
   * cannot fix, and wrong for a URL a client typed. A 404 naming the registered
   * strategies is both accurate and the more useful thing to read.
   */
  async loginWithStrategy(
    req: StrategyLoginRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const requested = req.params.strategy;

      if (!authStrategyRegistry.has(requested)) {
        throw new AppError(
          404,
          `Unknown auth strategy "${requested}". Available: ${authStrategyRegistry.keys.join(', ')}`,
          'UNKNOWN_AUTH_STRATEGY',
        );
      }

      const result = await authService.authenticate(requested, req.body);
      sendOk(res, result);
    } catch (err) {
      next(err);
    }
  },

  /**
   * Requests a magic link. Always 202, whether or not the address belongs to a
   * user — the endpoint is unauthenticated, and a response that distinguished
   * the two would enumerate the directory.
   */
  async requestMagicLink(
    req: BodyOf<MagicLinkRequestBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      await magicLinkIssuer.request(req.body.email);
      sendAccepted(res, { status: 'sent' });
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: BodyOf<RefreshBody>, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.refresh(req.body.refreshToken);
      sendOk(res, result);
    } catch (err) {
      next(err);
    }
  },

  async logout(req: BodyOf<LogoutBody>, res: Response, next: NextFunction): Promise<void> {
    try {
      await authService.logout(req.body.refreshToken);
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  },
};
