import { AppError } from '@/lib/errors';

/**
 * The ways a signed request can be refused.
 *
 * All `AppError` subclasses, so the translator registry renders them and
 * nothing has to be registered — see `lib/error-translators.ts`.
 *
 * ## What these messages are allowed to say
 *
 * The temptation with a verification failure is to answer every one of them
 * identically, on the grounds that a precise refusal tells an attacker
 * something. Here it does not, and the cost of being vague is real. The only
 * secret in the scheme is the shared key; none of the distinctions below depend
 * on it, because every one of them is decided *before or after* the digest
 * comparison rather than by it:
 *
 *   - a malformed or absent header is a fact about the request the sender
 *     constructed, which the sender already knows;
 *   - a stale timestamp is a fact about two clocks, and the tolerance is
 *     published in `.env.example` and the docs;
 *   - a spent nonce is a fact about this receiver's history with a value the
 *     sender itself chose;
 *   - an unheld key id is a fact about which secrets *this deployment* holds,
 *     and a key id is not secret — it travels in the clear in every signature
 *     header, in both directions, by design.
 *
 * What is collapsed is the only pair that would leak: a digest mismatch and a
 * key id we do not hold both answer `WEBHOOK_SIGNATURE_INVALID`, so nothing
 * probing key ids can tell "wrong secret" from "no such secret" and enumerate
 * the ring. See `WebhookSignatureInvalidError`.
 *
 * Being specific about the rest is what makes an integration debuggable at 2am
 * without shipping the receiver's logs to the sender's team, and every one of
 * these refusals is something the sender can fix.
 */

/** The route requires a signature and the request did not carry one. */
export class WebhookSignatureRequiredError extends AppError {
  constructor(headerName: string) {
    super(
      401,
      `This request requires a ${headerName} header`,
      'WEBHOOK_SIGNATURE_REQUIRED',
    );
    this.name = 'WebhookSignatureRequiredError';
  }
}

/**
 * The header was present but could not be read as a signature.
 *
 * 400 rather than 401: 401 is a claim about *authentication* — a credential was
 * offered and rejected — and nothing here was rejected, because nothing here
 * was parseable enough to check. A sender debugging its own serialisation is
 * helped by the difference, and a log full of 401s means something quite
 * different from a log full of 400s.
 */
export class WebhookSignatureMalformedError extends AppError {
  constructor(reason: string) {
    super(400, `Malformed webhook signature: ${reason}`, 'WEBHOOK_SIGNATURE_MALFORMED');
    this.name = 'WebhookSignatureMalformedError';
  }
}

/**
 * The timestamp in the header sits outside the accepted window.
 *
 * 400, not 401, for the same reason as above and one more: the credential may
 * well have been perfectly valid, and saying 401 would send an integrator
 * looking at their secret instead of at their clock. The message names the
 * tolerance and the observed skew, which is usually the entire diagnosis —
 * a container with no NTP, or a sender queueing deliveries for longer than the
 * window.
 *
 * Signed but stale is the case this exists for: a signature is a statement that
 * a body came from the holder of a secret, and it says nothing about *when*.
 * Without a window, one captured request stays replayable until the secret is
 * rotated, which may be never.
 */
export class WebhookTimestampOutOfWindowError extends AppError {
  constructor(skewSeconds: number, toleranceSeconds: number) {
    const direction = skewSeconds >= 0 ? 'old' : 'in the future';
    super(
      400,
      `Webhook timestamp is ${Math.abs(skewSeconds)}s ${direction}, ` +
        `outside the ±${toleranceSeconds}s tolerance`,
      'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW',
    );
    this.name = 'WebhookTimestampOutOfWindowError';
  }
}

/**
 * This nonce has already been spent inside the current window.
 *
 * 409 rather than 401, and this one is worth being careful about, because a
 * refusal here is the only refusal in this file that a *correct* sender can
 * provoke. It means the receiver has seen this exact nonce before — either
 * because the delivery is being replayed by someone who captured it, or because
 * the sender reused a nonce across two attempts.
 *
 * That second case is why this is not a 401 and not a 400. Both of those invite
 * a sender's error handling to give up permanently on a delivery that is not
 * actually malformed. 409 says: this particular *attempt* collided with
 * something already recorded, and a fresh attempt — new nonce, new timestamp,
 * new signature — is the fix.
 *
 * Note what this deliberately does not do: it is not deduplication. Two
 * attempts at delivering the same event are two nonces and both verify; which
 * of them the application treats as the duplicate is the idempotency layer's
 * question, keyed on the event id, not the signature's. See
 * `docs/webhook-signing.md` — conflating the two gives you a receiver that
 * accepts a replayed credential because the event id was new, and rejects an
 * honest retry because the nonce was not.
 */
export class WebhookReplayedError extends AppError {
  constructor() {
    super(
      409,
      'This webhook signature has already been presented; retry with a fresh nonce',
      'WEBHOOK_REPLAYED',
    );
    this.name = 'WebhookReplayedError';
  }
}

/**
 * The digest did not match, or was computed under a key id this deployment does
 * not hold.
 *
 * Deliberately one error for both. Splitting them would turn the key id into an
 * oracle: a caller with no secret at all could walk key ids, learn which ones
 * this ring holds, and know exactly which secret to go after — and during a
 * rotation, learn precisely how far the fleet has got. One answer for both
 * costs an integrator very little, because the two live reasons for it are
 * "wrong secret" and "key id not deployed yet", and the receiver's own logs
 * record which of those happened with the key id attached.
 *
 * `reason` is carried for exactly that logging, and is never rendered into the
 * response — `AppError` only publishes `statusCode`, `message` and `code`.
 */
export class WebhookSignatureInvalidError extends AppError {
  constructor(public readonly reason: 'digest-mismatch' | 'unknown-key-id') {
    super(401, 'Webhook signature verification failed', 'WEBHOOK_SIGNATURE_INVALID');
    this.name = 'WebhookSignatureInvalidError';
  }
}

/**
 * The replay cache is full of unexpired nonces and cannot record another.
 *
 * 503 with a `Retry-After`, and the status is the whole decision. A bounded
 * cache that has hit its bound has two options and no third: forget replay
 * protection for this request, or refuse it. Forgetting is silent — the endpoint
 * keeps answering 200 and the guarantee is simply gone, which is the failure
 * mode nobody notices until it is being used. Refusing is loud, recoverable by
 * the sender's own retry ladder, and bounded in blast radius to one endpoint.
 *
 * So: fail closed. The trade is real and worth stating plainly — an attacker who
 * can flood this endpoint with distinct nonces can push it into 503, which is a
 * denial of service against a path they could already flood. What they cannot do
 * is flood it into *accepting replays*, which is what the alternative would
 * hand them. Sizing (`WEBHOOK_REPLAY_CACHE_MAX_ENTRIES`) is what keeps honest
 * traffic away from the bound, and a rate limiter in front of the endpoint is
 * what keeps dishonest traffic away from it; see `docs/webhook-signing.md` for
 * the arithmetic.
 *
 * `Retry-After` is the freshness tolerance, because that is when the cache starts
 * having room again: every record is held until its own timestamp leaves the
 * window, so one tolerance from now is the first moment the oldest entries are
 * certain to be collectable. It is derived rather than configured for the same
 * reason — a separate knob could be set to a value the cache cannot honour.
 */
export class WebhookReplayCacheFullError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(
      503,
      'The webhook replay cache is full and cannot record this delivery; ' +
        'the request was refused rather than accepted without replay protection',
      'WEBHOOK_REPLAY_CACHE_FULL',
      { 'Retry-After': String(retryAfterSeconds) },
    );
    this.name = 'WebhookReplayCacheFullError';
  }
}

/**
 * The signature verified and the body underneath it is not the JSON it claims to
 * be.
 *
 * Distinct from every other error here because of *when* it can happen: only
 * after the digest check has passed, which means the sender holds the secret and
 * this is a bug in their serialisation rather than an attack. That ordering is
 * the point — see `verifyWebhookSignature`, which parses nothing until the
 * signature is established, so the JSON parser is never reachable by an
 * unauthenticated caller.
 */
export class WebhookBodyMalformedError extends AppError {
  constructor(reason: string) {
    super(400, `Webhook body is not valid JSON: ${reason}`, 'WEBHOOK_BODY_MALFORMED');
    this.name = 'WebhookBodyMalformedError';
  }
}
