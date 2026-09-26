import { Router, type Request, type Response } from 'express';
import { env } from '@/config/env';
import { sendAccepted } from '@/lib/response';
import { AppError } from '@/lib/errors';
import { MemoryReplayGuard } from '@/webhooks/replay-guard';
import {
  parseWebhookSigningSecrets,
  type WebhookSigningSecretRing,
} from '@/webhooks/signing-secrets';
import { verifyWebhookSignature } from '@/webhooks/verify-signature.middleware';

/**
 * `POST /v1/webhooks/inbound` — the receiving endpoint, and the composition root
 * for everything in this module.
 *
 * ## Where the pieces are put together
 *
 * The ring and the replay guard are built here, once, from configuration, for
 * the reason the rate limiters are module singletons: a guard constructed per
 * request remembers nothing, and a guard constructed per router is the same
 * object for the lifetime of the process, which is what "seen before" requires.
 * They are *built here* rather than exported from `signing-secrets.ts` so that
 * every other file in the module stays free of `env` — which is what lets the
 * tests drive them with fixed clocks and two-entry rings instead of the
 * deployment's configuration.
 *
 * ## Why the raw body is not arranged here
 *
 * It cannot be. By the time a request reaches a router mounted under `/v1`,
 * `createApp` has already run `express.json()` over it and the bytes the
 * signature covers are gone. So the raw parser is mounted in `createApp`, on
 * `WEBHOOKS_RAW_BODY_PATH`, ahead of the body parsers — see the comment there —
 * and this router receives a `Buffer`. Both halves derive their path from
 * `WEBHOOKS_ROUTER_PATH` below so the two cannot drift apart, which would
 * otherwise be a silent 500 on every delivery the day somebody renames a route.
 */

/** Where `v1Router` mounts this router. */
export const WEBHOOKS_ROUTER_PATH = '/webhooks';

/**
 * Where `createApp` mounts the raw body parser, ahead of `express.json()`.
 *
 * Derived from the mount path rather than written out, because the failure when
 * the two disagree is not a 404 — it is a 500 from `readRawBody` on every
 * delivery, and only on deliveries, which is the sort of thing that is noticed
 * by a counterparty.
 */
export const WEBHOOKS_RAW_BODY_PATH = `/v1${WEBHOOKS_ROUTER_PATH}`;

/**
 * The largest body this endpoint will accept, in bytes.
 *
 * Lower than a general-purpose API's limit and deliberately so: the signature is
 * computed over the whole body, so the body must be buffered in full before
 * anything about the caller is known. That makes the limit the only thing
 * standing between an unauthenticated request and this much heap, per concurrent
 * connection. 1 MB is generous for an event notification — the providers whose
 * payloads set the expectation here run well under 100 kB — and a receiver that
 * needs more is a receiver that should be sent a pointer to fetch rather than the
 * document itself.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;

const signingSecrets = parseWebhookSigningSecrets(
  env.WEBHOOK_SIGNING_SECRETS,
  env.WEBHOOK_SIGNING_ACTIVE_KEY_ID,
);

/**
 * Process-wide, and that is the whole point of it — see the class's own note on
 * what it cannot do across replicas.
 */
const replayGuard = new MemoryReplayGuard({
  maxEntries: env.WEBHOOK_REPLAY_CACHE_MAX_ENTRIES,
});

/**
 * The ring this process verifies with, and would sign outbound deliveries with.
 *
 * Exported as a function rather than as the value so that importing this module
 * for the router does not hand every caller a mutable-looking handle to the
 * secrets; and exported at all because the end-to-end suite has to produce a
 * request the running application accepts, which means signing under the ring the
 * application actually loaded rather than a ring the test invented. A suite that
 * builds its own secrets can only prove the middleware works — not that
 * `createApp` wired it to the configured ones.
 */
export function webhookSigningSecretRing(): WebhookSigningSecretRing {
  return signingSecrets;
}

const webhooksRouter: Router = Router();

webhooksRouter.post(
  '/inbound',
  verifyWebhookSignature({
    ring: signingSecrets,
    guard: replayGuard,
    toleranceSeconds: env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  }),
  (req: Request, res: Response) => {
    const signature = req.webhookSignature;
    if (signature === undefined) {
      // Unreachable while the middleware above is in the chain, and an assertion
      // rather than a `!` because the thing it is asserting is the security
      // property: that this handler only ever runs behind a verification that
      // passed. If somebody reorders the chain, this is a 500 naming the reason
      // rather than a handler quietly acting on an unsigned request.
      throw new AppError(
        500,
        'Webhook handler reached without a verified signature',
        'WEBHOOK_SIGNATURE_MISSING_ON_REQUEST',
      );
    }

    // 202, not 200, and not the result of any processing. A webhook sender's
    // retry ladder reads the status code and nothing else, so the status has to
    // mean "received, and you may stop retrying" — which is knowable now — and
    // not "processed", which is not. Doing the work inline would make every
    // downstream hiccup into a redelivery, and a redelivery of an event the
    // receiver has in fact already half-applied.
    //
    // Where the work goes instead: durably record the delivery and hand it to the
    // outbox or the queue, keyed on the sender's own event id so an honest
    // redelivery is collapsed by `@/idempotency` rather than by this module. The
    // nonce below is not that key — it is unique per *attempt* by construction,
    // which is exactly what makes it useless for recognising one.
    sendAccepted(res, {
      keyId: signature.keyId,
      nonce: signature.nonce,
      signedAt: new Date(signature.timestamp * 1000).toISOString(),
      bodyDigest: signature.bodyDigest,
      bodyBytes: signature.rawBody.byteLength,
    });
  },
);

export { webhooksRouter };
