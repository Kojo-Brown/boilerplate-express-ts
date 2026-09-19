import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';

/**
 * The composition, through the real application object.
 *
 * What the two suites in `src/security` cannot show: that `createApp()` mounts
 * both middlewares at all, that they sit high enough to cover a response no
 * route produced, and that the allowlist the running service enforces is the
 * one `CORS_ORIGIN` names rather than a default compiled in next to it. That
 * last point is the bug this feature closes — `CORS_ORIGIN` existed and was
 * read only by the WebSocket gateway, so a deployment could set it and have
 * its REST surface remain open to every origin.
 */
describe('security headers and CORS through the app', () => {
  const app = createApp();
  const allowedOrigin = env.CORS_ORIGIN;

  it('hardens a routed response', async () => {
    const res = await request(app).get('/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });

  it('hardens the response no route claimed', async () => {
    // The one most worth covering and the one a middleware mounted next to the
    // routers would miss: an unrouted path is where a probe lands.
    const res = await request(app).get('/definitely-not-a-route');

    expect(res.status).toBe(404);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('hardens the metrics exposition, which is mounted above the routers', async () => {
    const res = await request(app).get(env.METRICS_PATH);

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never names the framework', async () => {
    const res = await request(app).get('/v1/health/live');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('lets the configured origin read a response', async () => {
    const res = await request(app).get('/v1/health/live').set('Origin', allowedOrigin);

    expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(res.headers['access-control-expose-headers']).toContain('ETag');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('withholds the headers from an origin the environment did not name', async () => {
    const res = await request(app)
      .get('/v1/health/live')
      .set('Origin', 'https://not-configured.example.test');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a permitted preflight before the body parsers and the session', async () => {
    const res = await request(app)
      .options('/v1/users')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type, authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    // Set no cookie, because nothing reached `session()`.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('carries the security headers on the preflight it answers itself', async () => {
    // The ordering assertion: `corsMiddleware` short-circuits, so a 204 written
    // by it only has these if `securityHeaders` ran first.
    const res = await request(app)
      .options('/v1/users')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a preflight from an origin outside the allowlist', async () => {
    const res = await request(app)
      .options('/v1/users')
      .set('Origin', 'https://not-configured.example.test')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_ORIGIN_NOT_ALLOWED');
  });
});
