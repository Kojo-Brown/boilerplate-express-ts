import type { Request } from 'express';

/**
 * The label values, and the only part of this subsystem that can take a service
 * down on its own.
 *
 * Every distinct combination of label values is a separate time series — held
 * in this process for as long as it runs, and held in the scraper's index for
 * as long as its retention. Three labels that each take five values is 125
 * series and nobody notices. One label derived from `req.url` is a series per
 * URL anyone has ever sent, including the ones a vulnerability scanner made up,
 * and the way that ends is the scraper running out of memory rather than this
 * process — which is why it is worth this much care in a file this small.
 *
 * So every label here is bounded by construction, and each bound is a different
 * argument:
 *
 * - `route` is the matched *pattern* (`/v1/users/:id`), never the path, and is
 *   additionally capped — see `createRouteLabeller`. Reconstructing it is
 *   fiddlier than it looks; `mountPrefix` is where that is explained.
 * - `method` is folded onto a fixed list. Node's HTTP parser already rejects a
 *   method it does not know, so the set is finite without this; it is just far
 *   larger than the seven anything here answers.
 * - `status_code` is bounded by what this service returns.
 */

/**
 * Every request that matched no route, under one label.
 *
 * This is the bucket that matters. A 404 has no route pattern, so the obvious
 * fallback is the path — and the requests with no route are precisely the ones
 * with unpredictable paths: scanners, stale links, typos, `/.env`, `/wp-login`.
 * Labelling those individually is how a metrics endpoint becomes an unbounded
 * memory leak that an outsider controls the rate of.
 *
 * The name is deliberately not a valid route: nothing can collide with it, and
 * it reads as a bucket rather than as an endpoint somebody should go and find.
 */
export const ROUTE_UNMATCHED = '__unmatched__';

/**
 * Every route pattern discovered after the cap was reached, under one label.
 *
 * The backstop for the case `routePattern` cannot see — a router mounted on a
 * parameterised path whose parameters it could not restore (see
 * `restoreMountParams`), or a future route built from user input. Without it
 * the cap would have to be enforced by dropping observations, which loses real
 * traffic; folding them together keeps the request counted and makes the
 * *shape* of the problem visible, because this label appearing at all means
 * something is generating route patterns and wants looking at.
 */
export const ROUTE_OVER_LIMIT = '__over_limit__';

/**
 * The methods that get their own label value. Everything else is `OTHER`.
 *
 * Not a security bound — Node's parser will not hand us `PROPFIND-ish` — but a
 * relevance one: these seven are what this service answers, and a `TRACE` or a
 * `MKCOL` arriving is a thing to see in one line rather than a thing to give a
 * permanent series to. `OTHER` is uppercase so it sorts and reads with the rest.
 */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export const METHOD_OTHER = 'OTHER';

export function methodLabel(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : METHOD_OTHER;
}

/**
 * The route pattern Express matched, read defensively.
 *
 * `req.route` is typed `any` by `@types/express` and is genuinely polymorphic:
 * `path` is a string for the ordinary case, and a `RegExp` or an array for
 * `app.get(/^\/x/, …)` and `app.get(['/a', '/b'], …)`. Neither of the latter
 * two has a single stable string form — `String(regexp)` is an
 * implementation-defined pattern and an array is several routes at once — so
 * both fall through to `undefined` and are counted as unmatched rather than
 * given a label nobody can search for.
 *
 * `undefined` also covers the request that reached no route at all, which is
 * the case this function exists for.
 */
function matchedRoutePath(req: Request): string | undefined {
  const route: unknown = req.route;
  if (route === null || typeof route !== 'object') return undefined;

  const path: unknown = (route as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

/**
 * Collapses the joins: `/v1` + `/users/` is `/v1/users`, and `/` stays `/`.
 *
 * Purely cosmetic in effect and not in value — `/v1/users` and `/v1/users/`
 * reaching the scraper as two labels is two series for one endpoint and two
 * lines on every panel that groups by route. Express is non-`strict` by
 * default, so both spellings really do reach the same handler.
 */
export function normalizeRoutePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return trimmed === '' ? '/' : trimmed;
}

/**
 * A pattern whose segment count does not say how many URL segments it consumed.
 *
 * A wildcard (`/*splat`) matches one segment or twelve, and an Express 5
 * optional group (`/users{/:id}`) matches with or without its own. Either way
 * the arithmetic in `mountPrefix` cannot subtract a known number of segments
 * from the right-hand end, and guessing produces a prefix with real path
 * segments in it — which is unbounded, which is the one outcome this file
 * exists to prevent. Such a route is labelled by its own pattern alone.
 */
function consumesUnknownSegments(routePath: string): boolean {
  return routePath.includes('*') || routePath.includes('{');
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * The mount prefix, reconstructed from the original URL rather than read from
 * `req.baseUrl`.
 *
 * `req.baseUrl` is the obvious source and it is wrong here, which is worth
 * spelling out because every naive version of this middleware uses it. Express
 * rewrites `req.baseUrl`, `req.url` and `req.params` on the way *into* a
 * mounted router and restores them as the router stack unwinds — so by the time
 * a `finish` listener runs they hold whatever they held before the request
 * entered. They survive exactly one case: a handler that writes its response
 * synchronously and never calls `next`. Every other case is restored, and the
 * two that are restored are the interesting ones:
 *
 * - **an error response**, because the error travels up through each router's
 *   `done` callback — restoring as it goes — before the error middleware
 *   answers. `GET /v1/users/:id` without a token would be labelled `/:id`.
 * - **any asynchronous handler**, because the stack has unwound by the time the
 *   `await` resumes and the response is written. That is most real handlers.
 *
 * `req.originalUrl` and `req.route.path` are the two things that are *not*
 * rewritten, so the prefix is the original path with as many trailing segments
 * removed as the matched pattern accounts for.
 *
 * Case is folded, because Express's default routing is not case-sensitive:
 * `/V1/Users/1` reaches the same handler as `/v1/users/1` and would otherwise
 * be a second series — one per casing anybody tries, which is attacker-chosen
 * and multiplies per segment. Folding merges series rather than splitting them,
 * which is the direction that is safe to get wrong even under
 * `caseSensitive: true`.
 *
 * **The limitation this leaves.** A router mounted on a *parameterised* path
 * (`v1.use('/users/:userId/posts', …)`) has no pattern recoverable from the URL
 * — Express 5 keeps the mount path only as a compiled matcher, not as a string
 * — so its parameter values land in the prefix and each one is a series. Mount
 * routers on literal paths; every router in this repository does. The cap in
 * `createRouteLabeller` is what keeps the consequence of getting that wrong
 * bounded, rather than an outage.
 */
function mountPrefix(originalUrl: string, routePath: string): string {
  // `originalUrl` carries the query string and `?` cannot appear in a path, so
  // one split is enough — and it has to happen, or `/x?a=1` and `/x?a=2` are two
  // prefixes for one endpoint.
  const pathname = originalUrl.split('?')[0] ?? originalUrl;

  const urlSegments = segmentsOf(pathname);
  const consumed = segmentsOf(routePath).length;
  // `max(0, …)` for the shapes that should not arise — a pattern longer than
  // the URL it matched — rather than letting a negative slice count from the
  // far end and produce a label that is a suffix of the path.
  const keep = Math.max(0, urlSegments.length - consumed);

  const prefix = urlSegments.slice(0, keep).join('/').toLowerCase();
  return prefix === '' ? '' : `/${prefix}`;
}

/**
 * The full pattern a request matched, or `undefined` if it matched nothing.
 *
 * Read at the *end* of the request rather than the beginning, which is not a
 * detail: `req.route` is set by the router when it dispatches, so a caller that
 * asks on the way in is always told `undefined`.
 */
export function routePattern(req: Request): string | undefined {
  const routePath = matchedRoutePath(req);
  if (routePath === undefined) return undefined;

  if (consumesUnknownSegments(routePath)) return normalizeRoutePath(routePath);

  const originalUrl = typeof req.originalUrl === 'string' ? req.originalUrl : '';
  return normalizeRoutePath(`${mountPrefix(originalUrl, routePath)}${routePath}`);
}

export interface RouteLabeller {
  /** The `route` label for a finished request. Never unbounded, by construction. */
  label(req: Request): string;
  /** Distinct patterns admitted so far. Exported for the test and for a gauge. */
  readonly size: number;
}

export interface RouteLabellerOptions {
  readonly maxLabels: number;
}

/**
 * A labeller that will not emit more than `maxLabels` distinct route patterns.
 *
 * The set only ever grows, which is correct rather than a leak: a series the
 * scraper has already seen does not stop existing because this process stopped
 * emitting it, so "forgetting" a pattern would let the same one be re-admitted
 * later and make the cap mean nothing. Its ceiling is `maxLabels` strings.
 *
 * Deliberately per-process and not shared between replicas. The cap is about
 * what *this* process can put on the wire; a fleet-wide bound is the scraper's
 * job and it has `sample_limit` for it.
 */
export function createRouteLabeller(options: RouteLabellerOptions): RouteLabeller {
  const { maxLabels } = options;
  const seen = new Set<string>();

  return {
    label(req: Request): string {
      const pattern = routePattern(req);
      // Checked before the cap, so an unmatched request never spends budget:
      // it is one fixed label, and the flood this guards against is exactly the
      // kind of traffic that arrives with no route.
      if (pattern === undefined) return ROUTE_UNMATCHED;

      if (seen.has(pattern)) return pattern;
      if (seen.size >= maxLabels) return ROUTE_OVER_LIMIT;

      seen.add(pattern);
      return pattern;
    },
    get size(): number {
      return seen.size;
    },
  };
}
