import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '@/config/env';
import { sendFail } from '@/lib/response';

/**
 * The policy a `corsMiddleware` enforces, kept apart from the environment that
 * configures one.
 *
 * Same split as `ws/ws.server.ts` and `ws/ws.gateway.ts`: nothing in this file
 * reads `env`, so a test states the allowlist it is testing instead of
 * inheriting `http://localhost:3000` and asserting against a value it did not
 * choose. `corsPolicyFromEnv` is the single place the two are joined.
 */
export interface CorsPolicy {
  /** Exact origins allowed to read a response, or `null` for any. */
  readonly allowedOrigins: readonly string[] | null;
  readonly allowedMethods: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly exposedHeaders: readonly string[];
  readonly allowCredentials: boolean;
  readonly maxAgeSeconds: number;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Builds the policy this deployment is configured with.
 *
 * `*` is spelled out rather than inferred from an empty value, so allowing
 * every origin is a decision recorded in the environment rather than the
 * consequence of an unset variable — the same rule `wsAllowedOrigins` follows,
 * off the same `CORS_ORIGIN`.
 */
export function corsPolicyFromEnv(): CorsPolicy {
  const configured = env.CORS_ORIGIN.trim();

  return {
    allowedOrigins: configured === '*' ? null : splitList(configured),
    allowedMethods: splitList(env.CORS_ALLOWED_METHODS).map((method) => method.toUpperCase()),
    allowedHeaders: splitList(env.CORS_ALLOWED_HEADERS),
    exposedHeaders: splitList(env.CORS_EXPOSED_HEADERS),
    allowCredentials: env.CORS_ALLOW_CREDENTIALS,
    maxAgeSeconds: env.CORS_MAX_AGE_SECONDS,
  };
}

/**
 * Whether `origin` may read a response under `policy`.
 *
 * Exact string comparison, deliberately: an origin is a scheme, host and port,
 * and every allowlist bug worth having is a substring or suffix match that
 * accepted `https://example.com.attacker.test`. A deployment that needs a
 * pattern lists the origins it means.
 */
export function isOriginAllowed(policy: CorsPolicy, origin: string): boolean {
  if (policy.allowedOrigins === null) return true;

  return policy.allowedOrigins.includes(origin);
}

/**
 * The value for `Access-Control-Allow-Origin`, or `null` to send none.
 *
 * A wildcard policy reflects the caller's origin rather than answering `*`
 * whenever credentials are on. It cannot happen today — the pairing is refused
 * at boot — but the header is the one place where getting it wrong is silent
 * rather than loud, so the function does not depend on the check upstream.
 */
function allowOriginHeader(policy: CorsPolicy, origin: string): string | null {
  if (!isOriginAllowed(policy, origin)) return null;
  if (policy.allowedOrigins === null && !policy.allowCredentials) return '*';

  return origin;
}

function isPreflight(req: Request): boolean {
  return req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
}

/**
 * Cross-origin access control, driven entirely by `policy`.
 *
 * Three cases, and the difference between the last two is the part that is
 * usually wrong:
 *
 * - **No `Origin` header.** Not a cross-origin request. Nothing is added
 *   beyond the `Vary` below, and the request proceeds.
 * - **A preflight** — `OPTIONS` carrying `Access-Control-Request-Method`.
 *   Answered here and never routed: it exists only to ask this question, so
 *   there is no handler it could usefully reach. An origin outside the
 *   allowlist gets a 403 through the normal error envelope rather than a
 *   headerless 204. Both are failures in the browser, but only one of them
 *   appears in a log, a metric and a developer's network tab as a refusal
 *   instead of as a success that inexplicably did not work.
 * - **An actual request.** A permitted origin gets the response headers; one
 *   outside the allowlist is *still served*, with no CORS headers on it, and
 *   the browser withholds the response from the page. This is not laxity. A
 *   browser attaches `Origin` to every same-origin `POST` as well, and
 *   non-browser callers may send whatever they like, so a server-side refusal
 *   here would break same-origin writes and would protect nothing: a client
 *   that ignores CORS is not a browser and is not constrained by a 403 either.
 *   CORS is a rule about what a *browser* hands to a *page*, and it is enforced
 *   in the only place it can be.
 *
 * `Vary: Origin` goes on every response an origin-dependent policy produces,
 * including the ones with no `Origin` at all. That last part is the cache
 * correctness bug this avoids: without it, a shared cache can store the
 * headerless response to an unknown origin and replay it to a permitted one,
 * which fails in production, intermittently, for one customer.
 */
export function corsMiddleware(policy: CorsPolicy): RequestHandler {
  const allowedMethods = policy.allowedMethods.join(', ');
  const allowedHeaders = policy.allowedHeaders.join(', ');
  const exposedHeaders = policy.exposedHeaders.join(', ');
  const maxAge = String(policy.maxAgeSeconds);
  // A wildcard policy answers `*` to every caller, so its responses are
  // cacheable under one key. Anything narrower is not — and neither is a
  // wildcard policy with credentials on, which reflects the caller's own
  // origin and therefore produces a different response per origin despite
  // allowing them all.
  const varies = policy.allowedOrigins !== null || policy.allowCredentials;

  return function cors(req: Request, res: Response, next: NextFunction): void {
    if (varies) res.vary('Origin');

    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }

    const allowOrigin = allowOriginHeader(policy, origin);

    if (allowOrigin === null) {
      if (isPreflight(req)) {
        sendFail(res, 403, 'CORS_ORIGIN_NOT_ALLOWED', 'Origin is not allowed by the CORS policy');
        return;
      }

      next();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    if (policy.allowCredentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (exposedHeaders !== '') res.setHeader('Access-Control-Expose-Headers', exposedHeaders);

    if (!isPreflight(req)) {
      next();
      return;
    }

    // Preflight responses vary on more than the origin. A browser caches the
    // answer per (origin, method, headers), and an intermediary that does not
    // know that will serve the answer for one method as the answer for another.
    res.vary('Access-Control-Request-Method');
    res.vary('Access-Control-Request-Headers');

    res.setHeader('Access-Control-Allow-Methods', allowedMethods);
    if (allowedHeaders !== '') res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
    res.setHeader('Access-Control-Max-Age', maxAge);
    // 204 rather than 200: there is no body, and `Content-Length: 0` on a 200
    // is what trips the handful of clients that treat an empty 200 as an error.
    res.status(204).end();
  };
}
