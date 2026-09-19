import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { env } from '@/config/env';

/**
 * The header policy, kept apart from the environment that configures one —
 * same split as `CorsPolicy` next door, and for the same reason.
 */
export interface SecurityHeaderPolicy {
  readonly cspEnabled: boolean;
  readonly cspReportOnly: boolean;
  /** Empty for a policy that carries no `report-uri`. */
  readonly cspReportUri: string;
  /** `0` omits `Strict-Transport-Security` entirely. */
  readonly hstsMaxAgeSeconds: number;
  readonly hstsIncludeSubDomains: boolean;
  readonly hstsPreload: boolean;
}

export function securityHeaderPolicyFromEnv(): SecurityHeaderPolicy {
  return {
    cspEnabled: env.CSP_ENABLED,
    cspReportOnly: env.CSP_REPORT_ONLY,
    cspReportUri: env.CSP_REPORT_URI,
    hstsMaxAgeSeconds: env.HSTS_MAX_AGE_SECONDS,
    hstsIncludeSubDomains: env.HSTS_INCLUDE_SUBDOMAINS,
    hstsPreload: env.HSTS_PRELOAD,
  };
}

/**
 * The strictest policy a Content-Security-Policy can express, which is the one
 * a JSON API can afford.
 *
 * `default-src 'none'` denies every *fetch* directive at once — scripts,
 * styles, images, frames, connections. The three that follow it are not
 * redundancy: `base-uri`, `form-action` and `frame-ancestors` do not fall back
 * to `default-src`, so a policy that stops at the first line leaves a document
 * served from this origin free to be framed and to have its `<base>` rewritten.
 * Every real-world "we had CSP and it did not help" is one of those three.
 *
 * Nothing this service returns is a document today, so none of it is load
 * bearing yet — which is exactly when to set it, because the header is already
 * correct on the day someone adds an HTML error page or mounts a Swagger UI,
 * and that is the day a permissive default would have become a problem. What
 * that person has to do is widen this function and say why, in a diff a
 * reviewer sees.
 *
 * Deliberately absent: `upgrade-insecure-requests`, which rewrites a
 * *document's* subresource URLs and so has nothing to act on in a response
 * carrying no subresources. HSTS below is what moves this API onto TLS.
 */
export function cspDirectives(reportUri: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };

  if (reportUri !== '') directives['report-uri'] = [reportUri];

  return directives;
}

/**
 * Every response header this service sets for the browser's benefit.
 *
 * Mounted first in `createApp`, ahead of the routers and ahead of the 404
 * handler, because the response most worth hardening is the one no route
 * claimed.
 *
 * The non-obvious choices:
 *
 * - `useDefaults: false` on the CSP. Helmet's defaults are written for an app
 *   that serves HTML and include `script-src 'self'`; merged with the policy
 *   above they would relax it, which is the opposite of what a reader of this
 *   file would assume was happening.
 * - `referrerPolicy: no-referrer`. API URLs carry resource ids, and helmet's
 *   default (`no-referrer`) is right here for a reason worth stating: there is
 *   no analytics case on an API to trade it against.
 * - `crossOriginResourcePolicy: same-origin`. It bounds *no-cors* loads — an
 *   `<img src>` or a `<script src>` pointed at this API — and is not consulted
 *   for a CORS-mode `fetch`, so it does not overlap with, or undo, the
 *   allowlist in `cors.ts`. A deployment serving public images through the
 *   download route is the case for loosening it.
 * - `xFrameOptions: deny` alongside `frame-ancestors 'none'`. The CSP
 *   directive supersedes it in every browser that implements CSP2, and the
 *   legacy header costs one line and covers the ones that do not.
 * - `crossOriginEmbedderPolicy` left off, which is helmet's own default.
 *   `require-corp` is a property of a *document* that wants cross-origin
 *   isolation; asserting it on JSON constrains nothing and breaks any page
 *   that embeds this API's responses without a CORP header of its own.
 */
export function securityHeaders(policy: SecurityHeaderPolicy): RequestHandler {
  return helmet({
    contentSecurityPolicy: policy.cspEnabled
      ? {
          useDefaults: false,
          directives: cspDirectives(policy.cspReportUri),
          reportOnly: policy.cspReportOnly,
        }
      : false,
    strictTransportSecurity:
      policy.hstsMaxAgeSeconds > 0
        ? {
            maxAge: policy.hstsMaxAgeSeconds,
            includeSubDomains: policy.hstsIncludeSubDomains,
            preload: policy.hstsPreload,
          }
        : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    xFrameOptions: { action: 'deny' },
  });
}
