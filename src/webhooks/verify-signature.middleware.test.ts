import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@/lib/errors';
import { MemoryReplayGuard, type ReplayDecision, type ReplayGuard } from '@/webhooks/replay-guard';
import { signWebhookRequest } from '@/webhooks/sign-request';
import { formatSignatureHeader, WEBHOOK_SIGNATURE_HEADER } from '@/webhooks/signature';
import { parseWebhookSigningSecrets } from '@/webhooks/signing-secrets';
import { verifyWebhookSignature } from '@/webhooks/verify-signature.middleware';
import {
  WebhookBodyMalformedError,
  WebhookReplayCacheFullError,
  WebhookReplayedError,
  WebhookSignatureInvalidError,
  WebhookSignatureMalformedError,
  WebhookSignatureRequiredError,
  WebhookTimestampOutOfWindowError,
} from '@/webhooks/webhooks.errors';

const SECRET_ACTIVE = randomBytes(32).toString('base64');
const SECRET_RETIRED = randomBytes(32).toString('base64');
const FOREIGN_SECRET = randomBytes(32).toString('base64');

/** `k-old` is held and not active: the state a rotation spends most of its life in. */
const ring = parseWebhookSigningSecrets(
  `k-old:${SECRET_RETIRED},k-new:${SECRET_ACTIVE}`,
  'k-new',
);

const TOLERANCE_SECONDS = 300;
const NOW_MS = 1_760_000_000_000;
const TARGET = '/v1/webhooks/inbound';
const BODY = '{"id":"evt_1","kind":"invoice.paid"}';

/**
 * A request carrying a real signature over real bytes.
 *
 * Built with `signWebhookRequest` rather than with a hand-rolled HMAC on purpose:
 * a suite that computes the expected digest its own way is a suite that passes
 * when both sides are wrong in the same direction. The one thing it must not
 * share with the middleware is the *clock*, which is why both are injected
 * separately below.
 */
function signedRequest(
  options: {
    ringOverride?: typeof ring;
    atMs?: number;
    body?: string;
    target?: string;
    method?: string;
    nonce?: string;
  } = {},
): Request {
  const {
    ringOverride = ring,
    atMs = NOW_MS,
    body = BODY,
    target = TARGET,
    method = 'POST',
    nonce,
  } = options;

  const signed = signWebhookRequest({
    ring: ringOverride,
    method,
    url: target,
    body,
    now: () => atMs,
    ...(nonce === undefined ? {} : { nonce: () => nonce }),
  });

  return mockRequest({
    method,
    originalUrl: target,
    body: Buffer.from(body, 'utf8'),
    headers: { [WEBHOOK_SIGNATURE_HEADER]: signed.headers[WEBHOOK_SIGNATURE_HEADER] },
  });
}

function mockRequest(overrides: Partial<Request>): Request {
  return { method: 'POST', originalUrl: TARGET, headers: {}, ...overrides } as unknown as Request;
}

function middleware(
  overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {},
): ReturnType<typeof verifyWebhookSignature> {
  return verifyWebhookSignature({
    ring,
    guard: new MemoryReplayGuard({ now: () => NOW_MS }),
    toleranceSeconds: TOLERANCE_SECONDS,
    now: () => NOW_MS,
    ...overrides,
  });
}

/** Runs the middleware and reports what it handed to `next`. */
async function run(
  handler: ReturnType<typeof verifyWebhookSignature>,
  req: Request,
): Promise<{ error: unknown; req: Request }> {
  let captured: unknown;
  const next = ((error?: unknown) => {
    captured = error;
  }) as NextFunction;

  await handler(req, {} as Response, next);
  return { error: captured, req };
}

describe('verifyWebhookSignature', () => {
  it('accepts a signature over the exact bytes received', async () => {
    const { error, req } = await run(middleware(), signedRequest());

    expect(error).toBeUndefined();
    expect(req.webhookSignature?.keyId).toBe('k-new');
    expect(req.webhookSignature?.timestamp).toBe(NOW_MS / 1000);
    expect(req.webhookSignature?.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a delivery signed under a held but retired secret', async () => {
    // Phase one of a rotation: the counterparty has not redeployed and is still
    // signing under `k-old`. A verifier narrowed to the active key would refuse
    // this, which is the outage the ring exists to prevent.
    const stillOnOldKey = parseWebhookSigningSecrets(
      `k-old:${SECRET_RETIRED},k-new:${SECRET_ACTIVE}`,
      'k-old',
    );
    const { error, req } = await run(
      middleware(),
      signedRequest({ ringOverride: stillOnOldKey }),
    );

    expect(error).toBeUndefined();
    expect(req.webhookSignature?.keyId).toBe('k-old');
  });

  it('replaces the body with the parsed payload and keeps the bytes reachable', async () => {
    const { req } = await run(middleware(), signedRequest());

    expect(req.body).toEqual({ id: 'evt_1', kind: 'invoice.paid' });
    expect(req.webhookSignature?.rawBody.toString('utf8')).toBe(BODY);
  });

  it('leaves the body a Buffer when asked to', async () => {
    const { error, req } = await run(
      middleware({ parseJsonBody: false }),
      signedRequest(),
    );

    expect(error).toBeUndefined();
    expect(Buffer.isBuffer(req.body)).toBe(true);
  });

  it('refuses a request carrying no signature', async () => {
    const { error } = await run(
      middleware(),
      mockRequest({ body: Buffer.from(BODY) }),
    );

    expect(error).toBeInstanceOf(WebhookSignatureRequiredError);
    expect((error as AppError).statusCode).toBe(401);
  });

  it('refuses a repeated signature header rather than picking one', async () => {
    const { error } = await run(
      middleware(),
      mockRequest({
        body: Buffer.from(BODY),
        headers: { [WEBHOOK_SIGNATURE_HEADER]: ['t=1,n=x,kid=k-new,v1=ff', 'also-this'] },
      }),
    );

    expect(error).toBeInstanceOf(WebhookSignatureMalformedError);
    expect((error as AppError).statusCode).toBe(400);
  });

  it('refuses a body the signature does not cover', async () => {
    // The whole point of the feature, and the case that fails silently in every
    // implementation that verifies a re-serialised body instead of the bytes.
    const req = signedRequest();
    req.body = Buffer.from(BODY.replace('invoice.paid', 'invoice.voided'), 'utf8');

    const { error } = await run(middleware(), req);

    expect(error).toBeInstanceOf(WebhookSignatureInvalidError);
    expect((error as AppError).statusCode).toBe(401);
    expect((error as WebhookSignatureInvalidError).reason).toBe('digest-mismatch');
  });

  it('refuses a delivery signed with a secret this deployment does not hold', async () => {
    const foreign = parseWebhookSigningSecrets(`k-new:${FOREIGN_SECRET}`, 'k-new');
    const { error } = await run(middleware(), signedRequest({ ringOverride: foreign }));

    expect(error).toBeInstanceOf(WebhookSignatureInvalidError);
    expect((error as WebhookSignatureInvalidError).reason).toBe('digest-mismatch');
  });

  it('answers an unheld key id identically to a wrong secret', async () => {
    // Deliberately indistinguishable from outside: splitting them would let a
    // caller with no secret at all walk key ids and learn which this ring holds —
    // and, during a rotation, how far the fleet has got. The `reason` the receiver
    // logs is what keeps the two diagnosable from inside.
    const undeployed = parseWebhookSigningSecrets(`k-future:${SECRET_ACTIVE}`, 'k-future');
    const { error } = await run(middleware(), signedRequest({ ringOverride: undeployed }));

    expect(error).toBeInstanceOf(WebhookSignatureInvalidError);
    expect((error as AppError).statusCode).toBe(401);
    expect((error as AppError).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect((error as WebhookSignatureInvalidError).reason).toBe('unknown-key-id');
  });

  it('refuses a signature valid for a different endpoint', async () => {
    // Cross-endpoint replay: two webhook routes under one secret. Signed for one,
    // presented at the other, and without the target in the canonical string both
    // would accept it.
    const req = signedRequest({ target: '/v1/webhooks/inbound' });
    (req as { originalUrl: string }).originalUrl = '/v1/webhooks/elsewhere';

    const { error } = await run(middleware(), req);
    expect(error).toBeInstanceOf(WebhookSignatureInvalidError);
  });

  it('refuses a signature valid for a different method', async () => {
    const req = signedRequest({ method: 'POST' });
    (req as { method: string }).method = 'DELETE';

    const { error } = await run(middleware(), req);
    expect(error).toBeInstanceOf(WebhookSignatureInvalidError);
  });

  it('accepts a delivery at the edge of the window in both directions', async () => {
    // Symmetric, because clock skew is: a sender running five minutes fast is as
    // common as one running five minutes slow.
    for (const offset of [TOLERANCE_SECONDS, -TOLERANCE_SECONDS]) {
      const { error } = await run(
        middleware(),
        signedRequest({ atMs: NOW_MS - offset * 1000 }),
      );
      expect(error).toBeUndefined();
    }
  });

  it('refuses a delivery one second outside the window, either way', async () => {
    for (const offset of [TOLERANCE_SECONDS + 1, -(TOLERANCE_SECONDS + 1)]) {
      const { error } = await run(
        middleware(),
        signedRequest({ atMs: NOW_MS - offset * 1000 }),
      );
      expect(error).toBeInstanceOf(WebhookTimestampOutOfWindowError);
      expect((error as AppError).statusCode).toBe(400);
    }
  });

  it('names the skew and the tolerance, which is usually the whole diagnosis', async () => {
    const { error } = await run(
      middleware(),
      signedRequest({ atMs: NOW_MS - 900_000 }),
    );

    expect((error as Error).message).toContain('900s old');
    expect((error as Error).message).toContain(`±${TOLERANCE_SECONDS}s`);
  });

  it('checks the window before spending an HMAC on the digest', async () => {
    // Ordering with a cost behind it: an expired delivery is refused whether or
    // not its digest is right, so computing the HMAC first would be work done for
    // nothing on exactly the traffic a flood consists of. Observed through the
    // guard, which a stale delivery must never reach.
    const guard = { remember: jest.fn() } as unknown as ReplayGuard;
    const { error } = await run(
      middleware({ guard }),
      signedRequest({ atMs: NOW_MS - 900_000 }),
    );

    expect(error).toBeInstanceOf(WebhookTimestampOutOfWindowError);
    expect(guard.remember).not.toHaveBeenCalled();
  });

  it('refuses a replayed delivery', async () => {
    // One captured delivery, presented twice inside the window. Both copies are
    // authentic, which is precisely why the signature alone cannot answer this.
    const handler = middleware();
    const first = signedRequest({ nonce: 'd'.repeat(32) });
    const second = signedRequest({ nonce: 'd'.repeat(32) });

    expect((await run(handler, first)).error).toBeUndefined();

    const { error } = await run(handler, second);
    expect(error).toBeInstanceOf(WebhookReplayedError);
    expect((error as AppError).statusCode).toBe(409);
  });

  it('records a nonce only after the digest has been checked', async () => {
    // The attack a guard consulted too early enables: capture a delivery, hold it,
    // and present a *tampered* copy first. If the nonce were spent on presentation
    // rather than on verification, the legitimate copy would arrive second and be
    // refused as a replay — a denial of service needing no secret at all.
    const handler = middleware();
    const tampered = signedRequest({ nonce: 'e'.repeat(32) });
    tampered.body = Buffer.from('{"id":"evt_forged"}', 'utf8');

    expect((await run(handler, tampered)).error).toBeInstanceOf(WebhookSignatureInvalidError);
    expect((await run(handler, signedRequest({ nonce: 'e'.repeat(32) }))).error).toBeUndefined();
  });

  it('holds a nonce for exactly as long as the window would admit it', async () => {
    // Retention derived from the *signed* timestamp, not from arrival: a delivery
    // that spent four of its five permitted minutes in a sender's queue has one
    // minute left in which it is replayable, and that is how long it needs
    // remembering. Here the window has closed, so the timestamp check refuses it
    // first — which is what makes forgetting it safe.
    const guard = new MemoryReplayGuard({ now: () => NOW_MS });
    const nonce = 'f'.repeat(32);
    const early = middleware({ guard });

    expect((await run(early, signedRequest({ nonce }))).error).toBeUndefined();

    const later = verifyWebhookSignature({
      ring,
      guard,
      toleranceSeconds: TOLERANCE_SECONDS,
      now: () => NOW_MS + (TOLERANCE_SECONDS + 1) * 1000,
    });
    expect((await run(later, signedRequest({ nonce }))).error).toBeInstanceOf(
      WebhookTimestampOutOfWindowError,
    );
  });

  it('refuses rather than accepting a delivery it cannot protect', async () => {
    // Fail closed at the cache bound. The alternative keeps answering 200 with
    // replay protection silently gone.
    const guard: ReplayGuard = {
      remember: (): Promise<ReplayDecision> => Promise.resolve('cache-full'),
    };
    const { error } = await run(middleware({ guard }), signedRequest());

    expect(error).toBeInstanceOf(WebhookReplayCacheFullError);
    expect((error as AppError).statusCode).toBe(503);
    expect((error as AppError).headers?.['Retry-After']).toBe(String(TOLERANCE_SECONDS));
  });

  it('reports a malformed payload only after the signature has verified', async () => {
    // Which is the property, not the status code: the JSON parser is never
    // reachable by a caller who does not hold the secret.
    const { error } = await run(middleware(), signedRequest({ body: '{"id":' }));

    expect(error).toBeInstanceOf(WebhookBodyMalformedError);
    expect((error as AppError).statusCode).toBe(400);
  });

  it('reports a wiring fault as a 500 rather than signing over a re-serialisation', async () => {
    // What a body parser upstream of the raw parser looks like from in here. The
    // tempting alternative — `Buffer.from(JSON.stringify(req.body))` — verifies a
    // re-serialisation nobody sent, and fails only for the senders whose key order
    // or number formatting differs from V8's.
    const req = signedRequest();
    req.body = { id: 'evt_1', kind: 'invoice.paid' };

    const { error } = await run(middleware(), req);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(500);
    expect((error as AppError).code).toBe('WEBHOOK_RAW_BODY_MISSING');
  });

  it('refuses a malformed header without consulting the ring', async () => {
    const { error } = await run(
      middleware(),
      mockRequest({
        body: Buffer.from(BODY),
        headers: { [WEBHOOK_SIGNATURE_HEADER]: 'kid=k-new,v1=deadbeef' },
      }),
    );

    expect(error).toBeInstanceOf(WebhookSignatureMalformedError);
  });

  it('refuses a digest of the right shape and the wrong value', async () => {
    // The forgery attempt the constant-time comparison is for. Asserted here as
    // well as in `signature.test.ts` because this is the path an attacker takes.
    const { error } = await run(
      middleware(),
      mockRequest({
        body: Buffer.from(BODY),
        headers: {
          [WEBHOOK_SIGNATURE_HEADER]: formatSignatureHeader({
            timestamp: NOW_MS / 1000,
            nonce: 'a'.repeat(32),
            keyId: 'k-new',
            digest: '0'.repeat(64),
          }),
        },
      }),
    );

    expect(error).toBeInstanceOf(WebhookSignatureInvalidError);
    expect((error as WebhookSignatureInvalidError).reason).toBe('digest-mismatch');
  });

  it('rejects a nonsensical tolerance at construction', () => {
    // A zero or negative window refuses everything; a non-finite one accepts
    // everything. Neither is a thing to discover from a delivery.
    for (const toleranceSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        verifyWebhookSignature({
          ring,
          guard: new MemoryReplayGuard(),
          toleranceSeconds,
        }),
      ).toThrow(RangeError);
    }
  });
});
