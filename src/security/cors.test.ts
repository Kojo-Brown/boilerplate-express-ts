import express from 'express';
import request from 'supertest';
import { corsMiddleware, isOriginAllowed } from '@/security/cors';
import type { CorsPolicy } from '@/security/cors';

const APP_ORIGIN = 'https://app.example.test';
const OTHER_ORIGIN = 'https://other.example.test';

function policy(overrides: Partial<CorsPolicy> = {}): CorsPolicy {
  return {
    allowedOrigins: [APP_ORIGIN],
    allowedMethods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'If-Match'],
    exposedHeaders: ['ETag'],
    allowCredentials: false,
    maxAgeSeconds: 600,
    ...overrides,
  };
}

function appWith(p: CorsPolicy): express.Application {
  const app = express();
  app.use(corsMiddleware(p));
  app.get('/thing', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post('/thing', (_req, res) => {
    res.status(201).json({ ok: true });
  });
  return app;
}

describe('isOriginAllowed', () => {
  it('compares origins exactly, so a suffix cannot pass as the real one', () => {
    // The bug this exists to not have. A `endsWith` allowlist accepts a domain
    // an attacker can register, and the resulting hole is invisible in every
    // test written with the allowed origin.
    const p = policy();

    expect(isOriginAllowed(p, APP_ORIGIN)).toBe(true);
    expect(isOriginAllowed(p, `${APP_ORIGIN}.attacker.test`)).toBe(false);
    expect(isOriginAllowed(p, 'https://evil.test/?x=https://app.example.test')).toBe(false);
    expect(isOriginAllowed(p, 'http://app.example.test')).toBe(false);
    expect(isOriginAllowed(p, 'https://app.example.test:8443')).toBe(false);
  });

  it('accepts anything under a wildcard policy', () => {
    expect(isOriginAllowed(policy({ allowedOrigins: null }), OTHER_ORIGIN)).toBe(true);
  });
});

describe('corsMiddleware — requests carrying no Origin', () => {
  it('adds no access-control headers and lets the request through', async () => {
    const res = await request(appWith(policy())).get('/thing');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still marks the response as varying on Origin', async () => {
    // The cache-correctness half. Without this a shared cache can store the
    // headerless answer given to a non-browser client and replay it to a
    // permitted origin, which fails intermittently for one customer and is
    // unreproducible everywhere else.
    const res = await request(appWith(policy())).get('/thing');

    expect(res.headers['vary']).toContain('Origin');
  });

  it('omits Vary entirely under a wildcard policy, whose answer never varies', async () => {
    const res = await request(appWith(policy({ allowedOrigins: null }))).get('/thing');

    expect(res.headers['vary']).toBeUndefined();
  });

  it('varies again under a wildcard policy with credentials, which reflects the caller', async () => {
    // Allowing every origin is not the same as answering every origin
    // identically. With credentials on the header carries the caller's own
    // origin, so the response is per-origin and a shared cache keying it on
    // the URL alone hands one site's answer to another.
    const res = await request(
      appWith(policy({ allowedOrigins: null, allowCredentials: true })),
    ).get('/thing');

    expect(res.headers['vary']).toContain('Origin');
  });
});

describe('corsMiddleware — actual requests', () => {
  it('reflects a permitted origin and exposes the readable headers', async () => {
    const res = await request(appWith(policy())).get('/thing').set('Origin', APP_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['access-control-expose-headers']).toBe('ETag');
  });

  it('serves an origin outside the allowlist, without the headers that would let it read', async () => {
    // Not laxity, and the reason is worth pinning: a browser attaches `Origin`
    // to same-origin writes too, so refusing here would break them — and a
    // caller that ignores CORS is not a browser and would ignore a 403 just as
    // happily. The browser is the only place this can be enforced.
    const res = await request(appWith(policy())).post('/thing').set('Origin', OTHER_ORIGIN);

    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('answers a wildcard policy with `*` rather than the caller, so the response is cacheable', async () => {
    const res = await request(appWith(policy({ allowedOrigins: null })))
      .get('/thing')
      .set('Origin', OTHER_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('reflects the caller even under a wildcard policy once credentials are on', async () => {
    // `*` with credentials is rejected by the browser outright, so the only
    // honest answer is the caller's own origin. Boot refuses this combination
    // today; the header logic does not rely on that, because getting it wrong
    // here fails silently rather than loudly.
    const res = await request(
      appWith(policy({ allowedOrigins: null, allowCredentials: true })),
    )
      .get('/thing')
      .set('Origin', OTHER_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(OTHER_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('omits the credentials header entirely when credentials are off', async () => {
    // `false` is not a valid value for this header — the absence is the
    // negative, and a literal `false` is read by some stacks as presence.
    const res = await request(appWith(policy())).get('/thing').set('Origin', APP_ORIGIN);

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('corsMiddleware — preflight', () => {
  it('answers a permitted preflight itself and never routes it', async () => {
    const app = express();
    const routed = jest.fn();
    app.use(corsMiddleware(policy()));
    app.options('/thing', routed);

    const res = await request(app)
      .options('/thing')
      .set('Origin', APP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(routed).not.toHaveBeenCalled();
  });

  it('advertises the methods, headers and cache lifetime from the policy', async () => {
    const res = await request(appWith(policy()))
      .options('/thing')
      .set('Origin', APP_ORIGIN)
      .set('Access-Control-Request-Method', 'DELETE');

    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, DELETE');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Content-Type, Authorization, If-Match',
    );
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('varies on the request-method and request-header negotiation, not only the origin', async () => {
    // A cache that keys a preflight on the origin alone serves the answer for
    // one method as the answer for another.
    const res = await request(appWith(policy()))
      .options('/thing')
      .set('Origin', APP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    const vary = res.headers['vary'] ?? '';
    expect(vary).toContain('Origin');
    expect(vary).toContain('Access-Control-Request-Method');
    expect(vary).toContain('Access-Control-Request-Headers');
  });

  it('refuses an origin outside the allowlist with the API error envelope', async () => {
    // A headerless 204 would fail in the browser just the same, and would look
    // like a success in every log and metric this service keeps.
    const res = await request(appWith(policy()))
      .options('/thing')
      .set('Origin', OTHER_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({
      code: 'CORS_ORIGIN_NOT_ALLOWED',
      message: 'Origin is not allowed by the CORS policy',
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('treats an OPTIONS without Access-Control-Request-Method as an ordinary request', async () => {
    // A bare `OPTIONS` is a legitimate HTTP method-discovery request, not a
    // preflight. Swallowing it here would take the route's own answer away.
    const app = express();
    app.use(corsMiddleware(policy()));
    app.options('/thing', (_req, res) => {
      res.status(200).set('Allow', 'GET, POST').end();
    });

    const res = await request(app).options('/thing').set('Origin', OTHER_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['allow']).toBe('GET, POST');
  });
});
