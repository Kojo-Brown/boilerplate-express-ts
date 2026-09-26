/**
 * HMAC request signing for webhooks, in both directions.
 *
 * Four pieces, in the order a delivery passes through them: a ring of shared
 * secrets that makes rotation a deployment rather than an outage
 * (`signing-secrets.ts`), the canonical string and constant-time digest
 * comparison that are the scheme itself (`signature.ts`), the sender
 * (`sign-request.ts`), and the receiver — a freshness window plus a single-use
 * nonce, which are two halves of one guarantee (`verify-signature.middleware.ts`
 * and `replay-guard.ts`). `docs/webhook-signing.md` is the map.
 */

export {
  MIN_SECRET_BYTES,
  MAX_SECRET_BYTES,
  parseWebhookSigningSecrets,
  WebhookSigningSecretError,
} from '@/webhooks/signing-secrets';
export type {
  WebhookSigningSecret,
  WebhookSigningSecretRing,
} from '@/webhooks/signing-secrets';

export {
  bodyDigest,
  canonicalRequest,
  computeDigest,
  digestsMatch,
  formatSignatureHeader,
  parseSignatureHeader,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
} from '@/webhooks/signature';
export type { ParsedWebhookSignature, WebhookSigningParts } from '@/webhooks/signature';

export { signWebhookRequest } from '@/webhooks/sign-request';
export type { SignedWebhookRequest, SignWebhookRequestOptions } from '@/webhooks/sign-request';

export {
  DEFAULT_REPLAY_CACHE_MAX_ENTRIES,
  MemoryReplayGuard,
} from '@/webhooks/replay-guard';
export type {
  MemoryReplayGuardOptions,
  ReplayDecision,
  ReplayGuard,
} from '@/webhooks/replay-guard';

export { verifyWebhookSignature } from '@/webhooks/verify-signature.middleware';
export type {
  VerifiedWebhookSignature,
  VerifyWebhookSignatureOptions,
} from '@/webhooks/verify-signature.middleware';

export {
  WebhookBodyMalformedError,
  WebhookReplayCacheFullError,
  WebhookReplayedError,
  WebhookSignatureInvalidError,
  WebhookSignatureMalformedError,
  WebhookSignatureRequiredError,
  WebhookTimestampOutOfWindowError,
} from '@/webhooks/webhooks.errors';

export {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOKS_RAW_BODY_PATH,
  WEBHOOKS_ROUTER_PATH,
  webhooksRouter,
  webhookSigningSecretRing,
} from '@/webhooks/webhooks.router';
