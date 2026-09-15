import type { Request } from 'express';
import {
  METHOD_OTHER,
  ROUTE_OVER_LIMIT,
  ROUTE_UNMATCHED,
  createRouteLabeller,
  methodLabel,
  normalizeRoutePath,
  routePattern,
} from '@/metrics/labels';

/**
 * A finished request, as the labeller sees one.
 *
 * Two fields, because two fields are all that survive: `route`, which Express's
 * router sets when it dispatches, and `originalUrl`, which is never rewritten.
 * `baseUrl` and `params` are deliberately absent from this fake — they are
 * restored as the router stack unwinds, so a labeller that reads them passes a
 * test that supplies them and mislabels every error and every async response in
 * production. `mountPrefix` in `labels.ts` has the full story, and
 * `metrics.e2e.test.ts` asserts it against a real app.
 */
function request(fields: {
  route?: unknown;
  originalUrl?: string;
  method?: string;
  path?: string;
}): Request {
  return {
    route: fields.route,
    originalUrl: fields.originalUrl ?? fields.path ?? '/',
    method: fields.method ?? 'GET',
    path: fields.path ?? '/',
  } as unknown as Request;
}

describe('methodLabel', () => {
  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'keeps %s as itself',
    (method) => {
      expect(methodLabel(method)).toBe(method);
    },
  );

  it('uppercases, so a lowercase method is not a second series for the same verb', () => {
    expect(methodLabel('get')).toBe('GET');
  });

  it.each(['TRACE', 'MKCOL', 'PROPFIND', 'SEARCH'])('folds %s onto OTHER', (method) => {
    expect(methodLabel(method)).toBe(METHOD_OTHER);
  });
});

describe('normalizeRoutePath', () => {
  it('collapses the double slash a mount point and a route path produce together', () => {
    expect(normalizeRoutePath('/v1//users')).toBe('/v1/users');
  });

  it('drops a trailing slash, which would otherwise be a second series per endpoint', () => {
    expect(normalizeRoutePath('/v1/users/')).toBe('/v1/users');
  });

  it('leaves the root alone rather than reducing it to the empty string', () => {
    expect(normalizeRoutePath('/')).toBe('/');
  });

  it('answers the root for a path that trims away to nothing', () => {
    expect(normalizeRoutePath('')).toBe('/');
  });
});

describe('routePattern', () => {
  it('reconstructs the mount prefix from the URL and joins the matched pattern to it', () => {
    const pattern = routePattern(
      request({ originalUrl: '/v1/users/42', route: { path: '/:id' } }),
    );
    expect(pattern).toBe('/v1/users/:id');
  });

  it('keeps the parameter name, never the value it matched', () => {
    const pattern = routePattern(
      request({ originalUrl: '/v1/users/42', route: { path: '/:id' } }),
    );
    // The same label for a different id, which is the property the whole
    // subsystem rests on.
    expect(routePattern(request({ originalUrl: '/v1/users/99', route: { path: '/:id' } }))).toBe(
      pattern,
    );
  });

  it("normalises a router's own root route", () => {
    expect(routePattern(request({ originalUrl: '/v1/users', route: { path: '/' } }))).toBe(
      '/v1/users',
    );
  });

  it('gives a trailing slash the same label, since Express routes both to it', () => {
    expect(routePattern(request({ originalUrl: '/v1/users/', route: { path: '/' } }))).toBe(
      '/v1/users',
    );
  });

  it('strips the query string, which is not part of any route', () => {
    expect(
      routePattern(request({ originalUrl: '/v1/users/42?include=posts', route: { path: '/:id' } })),
    ).toBe('/v1/users/:id');
  });

  it('handles a multi-segment pattern under a mount', () => {
    expect(
      routePattern(
        request({ originalUrl: '/v1/auth/oauth/google/callback', route: { path: '/google/callback' } }),
      ),
    ).toBe('/v1/auth/oauth/google/callback');
  });

  it('handles a route registered on the app with no mount at all', () => {
    expect(routePattern(request({ originalUrl: '/v1/health', route: { path: '/v1/health' } }))).toBe(
      '/v1/health',
    );
  });

  /**
   * Express's default routing is case-insensitive, so `/V1/Users/1` reaches the
   * same handler. Unfolded, the prefix comes from the URL as typed and every
   * casing an outsider tries is another series — multiplying per segment.
   */
  it('folds the case of the reconstructed prefix', () => {
    expect(routePattern(request({ originalUrl: '/V1/Users/42', route: { path: '/:id' } }))).toBe(
      '/v1/users/:id',
    );
  });

  it('is undefined for a request that matched no route', () => {
    expect(routePattern(request({ route: undefined, path: '/wp-login.php' }))).toBeUndefined();
  });

  it('is undefined for a regular-expression route, which has no searchable label', () => {
    expect(routePattern(request({ route: { path: /^\/x/ } }))).toBeUndefined();
  });

  it('is undefined for a route registered against several paths at once', () => {
    expect(routePattern(request({ route: { path: ['/a', '/b'] } }))).toBeUndefined();
  });

  /**
   * A wildcard consumes an unknown number of segments, so the prefix cannot be
   * subtracted from the right. Falling back to the pattern alone keeps the
   * label bounded, which is the property that matters; the alternative — a
   * guessed prefix — puts real path segments in it.
   */
  it('labels a wildcard route by its pattern alone rather than guessing the prefix', () => {
    const shallow = routePattern(request({ originalUrl: '/v1/files/a', route: { path: '/*rest' } }));
    const deep = routePattern(
      request({ originalUrl: '/v1/files/a/b/c/d', route: { path: '/*rest' } }),
    );

    expect(shallow).toBe('/*rest');
    expect(deep).toBe(shallow);
  });

  it('labels an optional-segment route by its pattern alone, for the same reason', () => {
    expect(
      routePattern(request({ originalUrl: '/v1/users/42', route: { path: '/users{/:id}' } })),
    ).toBe('/users{/:id}');
  });

  it('does not produce a suffix of the path when the pattern is longer than the URL', () => {
    // Should not arise — a pattern cannot match a shorter URL — but a negative
    // slice count would count from the far end and invent a label, so the floor
    // is asserted rather than assumed.
    expect(routePattern(request({ originalUrl: '/a', route: { path: '/a/b/c' } }))).toBe('/a/b/c');
  });
});

describe('createRouteLabeller', () => {
  it('returns the pattern for a matched route', () => {
    const labeller = createRouteLabeller({ maxLabels: 10 });
    expect(
      labeller.label(request({ originalUrl: '/v1/users/42', route: { path: '/:id' } })),
    ).toBe('/v1/users/:id');
  });

  it('counts an unmatched request under one label however many paths arrive', () => {
    const labeller = createRouteLabeller({ maxLabels: 10 });

    for (const path of ['/.env', '/wp-login.php', '/admin', '/../../etc/passwd']) {
      expect(labeller.label(request({ route: undefined, path }))).toBe(ROUTE_UNMATCHED);
    }

    // The point of the assertion: none of that traffic bought a series, so an
    // outsider cannot spend the budget below.
    expect(labeller.size).toBe(0);
  });

  it('admits patterns up to the cap and folds the rest together', () => {
    const labeller = createRouteLabeller({ maxLabels: 2 });

    expect(labeller.label(request({ route: { path: '/a' } }))).toBe('/a');
    expect(labeller.label(request({ route: { path: '/b' } }))).toBe('/b');
    expect(labeller.label(request({ route: { path: '/c' } }))).toBe(ROUTE_OVER_LIMIT);
    expect(labeller.size).toBe(2);
  });

  it('keeps serving the patterns it admitted after the cap is reached', () => {
    const labeller = createRouteLabeller({ maxLabels: 1 });

    expect(labeller.label(request({ route: { path: '/a' } }))).toBe('/a');
    expect(labeller.label(request({ route: { path: '/b' } }))).toBe(ROUTE_OVER_LIMIT);
    // Not evicted by the overflow: a label the scraper has already seen must go
    // on being emitted, or its series looks like an endpoint that disappeared.
    expect(labeller.label(request({ route: { path: '/a' } }))).toBe('/a');
  });

  it('does not re-admit a pattern it has already seen, so repeats are free', () => {
    const labeller = createRouteLabeller({ maxLabels: 2 });

    for (let i = 0; i < 100; i += 1) {
      expect(labeller.label(request({ route: { path: '/a' } }))).toBe('/a');
    }
    expect(labeller.size).toBe(1);
  });
});
