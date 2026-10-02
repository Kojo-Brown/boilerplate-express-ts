import express from 'express';
import { createHash } from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { errorMiddleware } from '@/middleware/error.middleware';
import {
  clientCertificatePolicy,
  clientCertificatePolicyFromEnv,
  clientCertificateTlsOptions,
  requireClientCertificate,
  type ClientCertificatePolicy,
  type ClientCertificatePolicyInput,
  type RequireClientCertificateOptions,
} from '@/security/client-certificate.middleware';
import { ClientCertificatePolicyError } from '@/security/mtls.errors';
import { fixturePki, type FixtureCertificate } from '@/security/mtls.fixture';

const pki = fixturePki();

const CERT_HEADER = 'x-client-cert';
const VERIFY_HEADER = 'x-client-verify';

function policyInput(overrides: Partial<ClientCertificatePolicyInput> = {}): ClientCertificatePolicyInput {
  return {
    mode: 'proxy',
    trustedProxies: '127.0.0.1',
    certificateHeader: CERT_HEADER,
    verifyHeader: VERIFY_HEADER,
    verifySuccessValue: 'SUCCESS',
    allowedCommonNames: '',
    allowedPublicKeyFingerprints: '',
    ...overrides,
  };
}

function policy(overrides: Partial<ClientCertificatePolicyInput> = {}): ClientCertificatePolicy {
  return clientCertificatePolicy(policyInput(overrides));
}

/**
 * An app that answers with whatever the middleware published, so every
 * assertion is about `req.clientCertificate` rather than about a 200.
 */
function appWith(
  p: ClientCertificatePolicy,
  options: RequireClientCertificateOptions = {},
): express.Application {
  const app = express();

  app.get('/internal/thing', requireClientCertificate(p, options), (req, res) => {
    res.status(200).json({ identity: req.clientCertificate ?? null });
  });
  app.use(errorMiddleware);

  return app;
}

/** The header value a terminator would send: a percent-encoded PEM. */
function forwarded(certificate: FixtureCertificate): string {
  return encodeURIComponent(certificate.certificatePem);
}

describe('clientCertificatePolicy', () => {
  it('lowercases the header names so a configured X-Client-Cert is found', () => {
    const built = policy({ certificateHeader: 'X-Amzn-Mtls-Clientcert' });

    expect(built.certificateHeader).toBe('x-amzn-mtls-clientcert');
  });

  it('refuses a proxy-mode policy that names no trusted hop', () => {
    // The default configuration, deliberately: header-based client-certificate
    // verification cannot be mounted without stating which hop set the header.
    expect(() => policy({ trustedProxies: '' })).toThrow(ClientCertificatePolicyError);
    expect(() => policy({ trustedProxies: '' })).toThrow(/MTLS_TRUSTED_PROXIES/);
  });

  it('refuses a direct-mode policy that names trusted hops', () => {
    // The setting would be ignored, and a setting whose only effect is to be
    // ignored is an operator's false belief about what is being accepted.
    expect(() => policy({ mode: 'direct', trustedProxies: '10.0.0.0/8' })).toThrow(
      ClientCertificatePolicyError,
    );
  });

  it('builds a direct-mode policy with no hops', () => {
    expect(policy({ mode: 'direct', trustedProxies: '' }).mode).toBe('direct');
  });

  it('is what the environment defaults to, and that default is unusable on purpose', () => {
    // `MTLS_MODE` defaults to `proxy` and `MTLS_TRUSTED_PROXIES` to empty, so
    // mounting this with no configuration at all fails loudly at mount time
    // rather than quietly believing a forwarded header.
    expect(() => clientCertificatePolicyFromEnv()).toThrow(ClientCertificatePolicyError);
  });
});

describe('requireClientCertificate — proxy mode', () => {
  it('admits a verified, forwarded certificate and publishes the identity', async () => {
    const res = await request(appWith(policy()))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(200);
    expect(res.body.identity).toMatchObject({
      commonName: 'svc-ingest.clients.example.test',
      source: 'proxy',
    });
  });

  it('refuses a request from a peer whose headers are not believed', async () => {
    // Supertest connects over loopback, so a policy trusting only a private
    // range is a policy this request does not come through.
    const res = await request(appWith(policy({ trustedProxies: '10.0.0.0/8' })))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CLIENT_CERT_UNTRUSTED_HOP');
  });

  it('checks the hop before anything else', async () => {
    // Ordering, asserted: a request from an untrusted peer carrying no headers
    // at all is refused for the hop and not for the missing certificate. The
    // hop is the cheapest check and the one with an attacker behind it.
    const res = await request(appWith(policy({ trustedProxies: '10.0.0.0/8' }))).get(
      '/internal/thing',
    );

    expect(res.body.error.code).toBe('CLIENT_CERT_UNTRUSTED_HOP');
  });

  it('is not fooled by a forged X-Forwarded-For when trust proxy is on', async () => {
    // The vulnerability this policy's comment is about. `trust proxy` makes
    // `req.ip` come from a header the client wrote, so a middleware deciding
    // whether to believe the certificate header by looking at `req.ip` would be
    // letting the client vouch for itself.
    const app = appWith(policy({ trustedProxies: '10.0.0.0/8' }));
    app.set('trust proxy', true);

    const res = await request(app)
      .get('/internal/thing')
      .set('X-Forwarded-For', '10.0.0.7')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CLIENT_CERT_UNTRUSTED_HOP');
  });

  it('refuses a certificate the terminator did not say it verified', async () => {
    // The nginx `ssl_verify_client optional` case, which is the whole reason the
    // verdict header is mandatory: the certificate is forwarded either way.
    const res = await request(appWith(policy()))
      .get('/internal/thing')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CLIENT_CERT_NOT_VERIFIED');
    expect(res.body.error.message).toContain(VERIFY_HEADER);
  });

  it('quotes the terminator back when it reports a failure', async () => {
    const res = await request(appWith(policy()))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'FAILED:self signed certificate')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('FAILED:self signed certificate');
  });

  it('accepts the configured verdict however the terminator cased it', async () => {
    const res = await request(appWith(policy()))
      .get('/internal/thing')
      .set(VERIFY_HEADER, '  success ')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(200);
  });

  it('accepts any non-empty verdict under *, for a terminator that reports no failures', async () => {
    // ALB in verify mode drops an unverified client at the edge and sets its
    // X-Amzn-Mtls-Clientcert-* headers only on one it validated, so there is no
    // verdict to match — the evidence is the header's existence.
    const res = await request(appWith(policy({ verifySuccessValue: '*' })))
      .get('/internal/thing')
      .set(VERIFY_HEADER, '{"notBefore":"2026-01-01T00:00:00Z"}')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(200);
  });

  it('still requires the verdict header to be present and non-empty under *', async () => {
    const absent = await request(appWith(policy({ verifySuccessValue: '*' })))
      .get('/internal/thing')
      .set(CERT_HEADER, forwarded(pki.client));
    expect(absent.status).toBe(401);
    expect(absent.body.error.code).toBe('CLIENT_CERT_NOT_VERIFIED');

    const blank = await request(appWith(policy({ verifySuccessValue: '*' })))
      .get('/internal/thing')
      .set(VERIFY_HEADER, '   ')
      .set(CERT_HEADER, forwarded(pki.client));
    expect(blank.status).toBe(401);
    expect(blank.body.error.message).toContain('empty');
  });

  it('refuses a success verdict with no certificate behind it', async () => {
    const res = await request(appWith(policy())).get('/internal/thing').set(VERIFY_HEADER, 'SUCCESS');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CLIENT_CERT_REQUIRED');
  });

  it('answers 400 for a certificate header it cannot read', async () => {
    const res = await request(appWith(policy()))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, 'not-a-certificate');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CLIENT_CERT_MALFORMED');
  });

  it('refuses a repeated certificate header rather than taking the first value', async () => {
    // Node collapses repeated headers into one comma-joined value, so this is
    // the string the middleware actually sees when a terminator *adds* its
    // header instead of overwriting one the client already sent. The client's
    // value is first, which is what makes "take the leaf" an escalation rather
    // than a convenience.
    const res = await request(appWith(policy()))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, `${forwarded(pki.otherClient)}, ${forwarded(pki.client)}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CLIENT_CERT_MALFORMED');
  });

  it('refuses an expired certificate even though the terminator passed it', async () => {
    // The terminator validated the window at the edge, possibly minutes ago,
    // against a clock this process has no view of.
    const expiredAt = pki.client.parsed.validToDate.getTime() + 60_000;
    const res = await request(appWith(policy(), { now: () => expiredAt }))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CLIENT_CERT_OUTSIDE_VALIDITY');
    expect(res.body.error.message).toContain('expired');
  });

  it('refuses a certificate that is not valid yet', async () => {
    // Nearly always a fresh certificate being rolled out across a fleet whose
    // clocks disagree, which is why it is distinguished in the message.
    const beforeIssue = pki.client.parsed.validFromDate.getTime() - 60_000;
    const res = await request(appWith(policy(), { now: () => beforeIssue }))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.client));

    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain('not valid yet');
  });

  it('answers 403 for a valid certificate that is not on the allowlist', async () => {
    const res = await request(
      appWith(policy({ allowedCommonNames: 'svc-ingest.clients.example.test' })),
    )
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.otherClient));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CLIENT_CERT_FORBIDDEN');
  });

  it('does not echo the allowlist in the refusal', async () => {
    // The subject names of an internal fleet are a map of that fleet, and this
    // endpoint is reachable by anything holding any certificate from the same CA.
    const res = await request(
      appWith(policy({ allowedCommonNames: 'svc-payments.internal.example.test' })),
    )
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.otherClient));

    expect(res.body.error.message).not.toContain('svc-payments');
  });

  it('names the whole subject when a certificate has no single common name', async () => {
    const res = await request(
      appWith(policy({ allowedCommonNames: 'svc-reporting.clients.example.test' })),
    )
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.twoCommonNames));

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('svc-admin.clients.example.test');
  });

  it('relays the terminator verdict rather than re-walking the chain', async () => {
    // Asserted because it is the trust boundary of proxy mode and it surprises
    // people: a certificate from a CA this process has never heard of is
    // admitted when the terminator says it verified one, because in proxy mode
    // the terminator *is* the verifier and this process holds no trust store to
    // second-guess it with. Which is why the terminator's own client-CA
    // configuration is load bearing, and why the allowlist below exists.
    const res = await request(appWith(policy()))
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.foreignClient));

    expect(res.status).toBe(200);
  });

  it('is not saved by a name allowlist when an issuer goes wrong, and is by a key pin', async () => {
    // `foreignClient` carries `client`'s exact common name under a different CA
    // and a different key. A name allowlist cannot tell them apart; the pin can.
    // This is the concrete reason the two lists are not interchangeable.
    const named = await request(
      appWith(policy({ allowedCommonNames: 'svc-ingest.clients.example.test' })),
    )
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.foreignClient));

    expect(named.status).toBe(200);

    const pinned = await request(
      appWith(
        policy({
          allowedPublicKeyFingerprints: publicKeyPinOf(pki.client),
        }),
      ),
    )
      .get('/internal/thing')
      .set(VERIFY_HEADER, 'SUCCESS')
      .set(CERT_HEADER, forwarded(pki.foreignClient));

    expect(pinned.status).toBe(403);
  });

  it('ignores the socket entirely, so a client certificate cannot substitute for a header', async () => {
    // The mirror of the direct-mode assertion below. In proxy mode the identity
    // is the header; there is no path by which a socket-level certificate
    // bypasses the hop and verdict checks.
    const res = await request(appWith(policy())).get('/internal/thing');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CLIENT_CERT_NOT_VERIFIED');
  });
});

/**
 * The pin an operator would paste into the environment.
 *
 * Recomputed here rather than taken from `publicKeyFingerprintSha256`, so that
 * a change to how the module derives a pin fails these tests instead of moving
 * both sides of the comparison together.
 */
function publicKeyPinOf(certificate: FixtureCertificate): string {
  const spki = certificate.parsed.publicKey.export({ type: 'spki', format: 'der' });

  return createHash('sha256').update(spki).digest('hex');
}

describe('requireClientCertificate — direct mode, over a real handshake', () => {
  let server: https.Server;
  let port: number;

  const directPolicy = (overrides: Partial<ClientCertificatePolicyInput> = {}) =>
    policy({ mode: 'direct', trustedProxies: '', ...overrides });

  function listen(app: express.Application): Promise<void> {
    server = https.createServer(
      {
        key: pki.server.privateKeyPem,
        cert: pki.server.certificatePem,
        ...clientCertificateTlsOptions(pki.caPem),
      },
      app,
    );

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  function get(
    options: https.RequestOptions = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          path: '/internal/thing',
          method: 'GET',
          ca: pki.caPem,
          servername: 'localhost',
          ...options,
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            raw += chunk;
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(raw) as Record<string, unknown>,
            });
          });
        },
      );

      req.on('error', reject);
      req.end();
    });
  }

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it('admits a client whose chain this process validated itself', async () => {
    await listen(appWith(directPolicy()));

    const res = await get({
      cert: pki.client.certificatePem,
      key: pki.client.privateKeyPem,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      identity: { commonName: 'svc-ingest.clients.example.test', source: 'direct' },
    });
  });

  it('completes the handshake and refuses in HTTP when no certificate is sent', async () => {
    // The point of `rejectUnauthorized: false`. Without it the client gets a TLS
    // alert and an `ECONNRESET`, with no status, no body and nothing in the
    // access log — and an integrator who cannot tell which of five things is
    // wrong. The assertion is as much about there being a *response* as about
    // its code.
    await listen(appWith(directPolicy()));

    const res = await get();

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'CLIENT_CERT_REQUIRED' } });
  });

  it('refuses a certificate from a CA the listener does not trust', async () => {
    // Node reports this as `authorized === false`, and it is what `ca` in
    // `clientCertificateTlsOptions` buys: without replacing the bundled public
    // roots, every certificate from every public issuer would authenticate.
    await listen(appWith(directPolicy()));

    const res = await get({
      cert: pki.foreignClient.certificatePem,
      key: pki.foreignClient.privateKeyPem,
    });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'CLIENT_CERT_NOT_VERIFIED' } });
  });

  it('ignores a forged certificate header on an anonymous TLS connection', async () => {
    // The single most important assertion in this file. A middleware that read
    // the socket and fell back to the header when it found nothing would answer
    // 200 here, to a request that presented no certificate and copied a PEM out
    // of a public log.
    await listen(appWith(directPolicy()));

    const res = await get({
      headers: { [VERIFY_HEADER]: 'SUCCESS', [CERT_HEADER]: forwarded(pki.client) },
    });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'CLIENT_CERT_REQUIRED' } });
  });

  it('ignores a forged header even from a client holding a valid certificate', async () => {
    // Privilege escalation rather than impersonation: a legitimate client
    // presenting its own certificate and claiming to be a different one.
    await listen(appWith(directPolicy({ allowedCommonNames: 'svc-ingest.clients.example.test' })));

    const res = await get({
      cert: pki.otherClient.certificatePem,
      key: pki.otherClient.privateKeyPem,
      headers: { [VERIFY_HEADER]: 'SUCCESS', [CERT_HEADER]: forwarded(pki.client) },
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'CLIENT_CERT_FORBIDDEN' } });
  });

  it('applies the allowlist to a socket identity too', async () => {
    await listen(
      appWith(directPolicy({ allowedPublicKeyFingerprints: publicKeyPinOf(pki.client) })),
    );

    const admitted = await get({
      cert: pki.client.certificatePem,
      key: pki.client.privateKeyPem,
    });
    expect(admitted.status).toBe(200);

    const refused = await get({
      cert: pki.otherClient.certificatePem,
      key: pki.otherClient.privateKeyPem,
    });
    expect(refused.status).toBe(403);
  });
});

describe('requireClientCertificate — direct mode over plaintext', () => {
  it('refuses rather than reporting a server error', async () => {
    // Either the listener was built without `requestCert` or something is
    // reaching this process on a port that was never meant to serve the route.
    // This middleware cannot tell those apart, and both have to answer "not
    // authenticated" — a 500 would turn a security control into an availability
    // report.
    const res = await request(appWith(policy({ mode: 'direct', trustedProxies: '' }))).get(
      '/internal/thing',
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CLIENT_CERT_NO_TLS');
  });
});
