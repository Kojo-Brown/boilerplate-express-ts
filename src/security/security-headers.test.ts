import express from 'express';
import request from 'supertest';
import { cspDirectives, securityHeaders } from '@/security/security-headers';
import type { SecurityHeaderPolicy } from '@/security/security-headers';

function policy(overrides: Partial<SecurityHeaderPolicy> = {}): SecurityHeaderPolicy {
  return {
    cspEnabled: true,
    cspReportOnly: false,
    cspReportUri: '',
    hstsMaxAgeSeconds: 15_552_000,
    hstsIncludeSubDomains: true,
    hstsPreload: false,
    ...overrides,
  };
}

function appWith(p: SecurityHeaderPolicy): express.Application {
  const app = express();
  app.use(securityHeaders(p));
  app.get('/thing', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('cspDirectives', () => {
  it('names the three directives that do not fall back to default-src', () => {
    // The whole reason the policy is more than one line. `base-uri`,
    // `form-action` and `frame-ancestors` are unaffected by `default-src`, so
    // a policy that stops there leaves a document framable and its `<base>`
    // rewritable — which is every "we had CSP and it did not help".
    const directives = cspDirectives('');

    expect(directives).toEqual({
      'default-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it('adds report-uri only when a collector is configured', () => {
    expect(cspDirectives('')['report-uri']).toBeUndefined();
    expect(cspDirectives('https://csp.example.test/report')['report-uri']).toEqual([
      'https://csp.example.test/report',
    ]);
  });
});

describe('securityHeaders', () => {
  it('sends the strict policy on the enforcing header', async () => {
    const res = await request(appWith(policy())).get('/thing');

    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
    );
    expect(res.headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('moves the policy to the report-only header when asked', async () => {
    const res = await request(
      appWith(policy({ cspReportOnly: true, cspReportUri: 'https://csp.example.test/report' })),
    ).get('/thing');

    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['content-security-policy-report-only']).toContain(
      'report-uri https://csp.example.test/report',
    );
  });

  it('sends no policy at all when an edge supplies its own', async () => {
    // Two CSP headers are intersected rather than overridden, so leaving this
    // one on next to an HTML-serving edge's policy breaks the pages the edge
    // was protecting.
    const res = await request(appWith(policy({ cspEnabled: false }))).get('/thing');

    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('sends HSTS with the configured lifetime and subdomain coverage', async () => {
    const res = await request(appWith(policy())).get('/thing');

    expect(res.headers['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains',
    );
  });

  it('adds preload only when the deployment opted into it', async () => {
    const res = await request(
      appWith(policy({ hstsMaxAgeSeconds: 31_536_000, hstsPreload: true })),
    ).get('/thing');

    expect(res.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
  });

  it('omits HSTS entirely at max-age 0, rather than sending a second header', async () => {
    // For the deployment whose TLS terminator already sends one. Two HSTS
    // headers on a response is undefined, not stricter.
    const res = await request(appWith(policy({ hstsMaxAgeSeconds: 0 }))).get('/thing');

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sets the framing, sniffing, referrer and cross-origin headers', async () => {
    const res = await request(appWith(policy())).get('/thing');

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('removes the header that names the framework', async () => {
    const res = await request(appWith(policy())).get('/thing');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('leaves COEP off, which is a document concern and breaks embedders of this API', async () => {
    const res = await request(appWith(policy())).get('/thing');

    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
  });

  it('sends no upgrade-insecure-requests, which has no subresources to act on here', async () => {
    const res = await request(appWith(policy())).get('/thing');

    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });
});
