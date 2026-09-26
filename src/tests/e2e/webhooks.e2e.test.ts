import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { signWebhookRequest, WEBHOOK_SIGNATURE_HEADER } from '@/webhooks';
import { webhookSigningSecretRing } from '@/webhooks/webhooks.router';

/**
 * Signature verification through the real application object.
 *
 * What the unit suites in `src/webhooks` cannot show, and what this feature is
 * mostly at risk from:
 *
 *   - that `createApp()` mounts the raw body parser at all, ahead of
 *     `express.json()`, so the bytes the signature covers survive to the
 *     middleware. Everything in `verify-signature.middleware.test.ts` hands the
 *     middleware a `Buffer` by construction; only the composed app can get this
 *     wrong, and when it does the symptom is a 500 on every delivery;
 *   - that the ring the running service verifies with is the one
 *     `WEBHOOK_SIGNING_SECRETS` names, rather than a default compiled in beside
 *     it. This is the shape of bug Phase 10 has already found twice — a setting
 *     that exists, is read by one subsystem, and is quietly ignored by the one
 *     that matters;
 *   - that the target the sender signs and the target the receiver rebuilds agree
 *     once Express' mount-prefix stripping is in play. `req.url` inside a router
 *     is `/inbound`, not `/v1/webhooks/inbound`, and a verifier reading it would
 *     fail every delivery — a mistake no unit test with a hand-built request can
 *     make;
 *   - that these refusals render through `errorMiddleware` in the envelope the
 *     rest of the API uses.
 */
const app = createApp();
const path = '/v1/webhooks/inbound';

/** Signed with the ring the application loaded, which is half of what is on trial. */
function sign(body: string, options: { atMs?: number; target?: string } = {}) {
  const { atMs, target = path } = options;
  return signWebhookRequest({
    ring: webhookSigningSecretRing(),
    url: target,
    body,
    ...(atMs === undefined ? {} : { now: () => atMs }),
  });
}

function post(body: string, signatureHeader: string) {
  return request(app)
    .post(path)
    .set('content-type', 'application/json')
    .set(WEBHOOK_SIGNATURE_HEADER, signatureHeader)
    .send(body);
}

describe('webhook signature verification through the app', () => {
  it('accepts a signed delivery and acknowledges it', async () => {
    const body = JSON.stringify({ id: 'evt_e2e_1', kind: 'invoice.paid' });
    const signed = sign(body);

    const res = await post(body, signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '');

    expect(res.status).toBe(202);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toMatchObject({
      keyId: env.WEBHOOK_SIGNING_ACTIVE_KEY_ID,
      nonce: signed.signature.nonce,
      bodyBytes: Buffer.byteLength(body),
    });
  });

  it('verifies the bytes that arrived, not a re-serialisation of them', async () => {
    // The assertion that the raw parser is really in front of `express.json()`.
    // This body round-trips through `JSON.parse`/`JSON.stringify` to something
    // different — the spacing and the key order both move — so a verifier working
    // from the parsed object would compute a different digest and refuse it.
    const body = '{ "b":2,\n  "a":1 }';
    const signed = sign(body);

    const res = await post(body, signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '');

    expect(res.status).toBe(202);
    expect(JSON.stringify(JSON.parse(body))).not.toBe(body);
  });

  it('refuses an unsigned delivery', async () => {
    const res = await request(app)
      .post(path)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ id: 'evt_e2e_2' }));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_REQUIRED');
    expect(res.body.data).toBeNull();
  });

  it('refuses a body altered after signing', async () => {
    const signed = sign(JSON.stringify({ amount: 100 }));

    const res = await post(
      JSON.stringify({ amount: 1_000_000 }),
      signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '',
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    // The response says only that verification failed. Which of "wrong secret"
    // and "key id not held" it was stays in this deployment's logs.
    expect(res.body.error.message).not.toContain('key');
  });

  it('refuses a delivery older than the window', async () => {
    const body = JSON.stringify({ id: 'evt_e2e_3' });
    const staleBy = (env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 60) * 1000;
    const signed = sign(body, { atMs: Date.now() - staleBy });

    const res = await post(body, signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
  });

  it('refuses the same delivery presented twice', async () => {
    // End to end, through the process-wide guard the router builds — which is what
    // makes the singleton's lifetime part of the feature rather than a detail.
    const body = JSON.stringify({ id: 'evt_e2e_4' });
    const header = sign(body).headers[WEBHOOK_SIGNATURE_HEADER] ?? '';

    expect((await post(body, header)).status).toBe(202);

    const replay = await post(body, header);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('WEBHOOK_REPLAYED');
  });

  it('refuses a signature made for a different path', async () => {
    // Signed for a sibling endpoint and presented here. `originalUrl` is what
    // makes this check work at all: inside the router, `req.url` is `/inbound`.
    const body = JSON.stringify({ id: 'evt_e2e_5' });
    const signed = sign(body, { target: '/v1/webhooks/somewhere-else' });

    const res = await post(body, signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('refuses a signature made for the path without its query string', async () => {
    const body = JSON.stringify({ id: 'evt_e2e_6' });
    const signed = sign(body, { target: path });

    const res = await request(app)
      .post(`${path}?source=billing`)
      .set('content-type', 'application/json')
      .set(WEBHOOK_SIGNATURE_HEADER, signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('refuses a malformed signature header', async () => {
    const res = await post(JSON.stringify({ id: 'evt_e2e_7' }), 'v1=nonsense');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_MALFORMED');
  });

  it('leaves every other route on the JSON parser', async () => {
    // The raw parser is mounted on the webhook subtree only, and this is what says
    // so: a sibling route still receives a parsed body and still validates it.
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'not-an-email', password: '' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('carries the security headers every other response carries', async () => {
    const res = await post(JSON.stringify({ id: 'evt_e2e_8' }), 'v1=nonsense');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
