/**
 * The HMAC secrets this process can verify webhook signatures under, and which
 * one of them it signs outbound deliveries with.
 *
 * A ring rather than a secret, for the reason `@/crypto/keyring` is a ring: a
 * shared secret cannot be replaced in one step without a window in which one
 * side is using a value the other does not hold. Inbound, that window is every
 * delivery arriving signed under a secret the receiver has already forgotten —
 * 401s on traffic that is perfectly authentic. Outbound it is worse, because the
 * receiver is somebody else's service on somebody else's release schedule.
 *
 * So rotation is three deployments, and the middle one is why this type exists:
 *
 *   1. add the new secret to `WEBHOOK_SIGNING_SECRETS` everywhere. Verification
 *      now accepts both; signing has not moved. Nothing observable changes.
 *   2. point `WEBHOOK_SIGNING_ACTIVE_KEY_ID` at the new id. New signatures use
 *      it; anything still arriving under the old one still verifies.
 *   3. once no counterparty is signing under the old id — which is a fact about
 *      *their* deployment, not yours — drop it from the list.
 *
 * Verification therefore consults the whole ring and signing consults exactly
 * one entry. That asymmetry is the design, not an implementation detail: a
 * verifier narrowed to the active key would break step 1's whole purpose.
 *
 * Nothing here reads `env`. `@/config/env` calls `parseWebhookSigningSecrets` at
 * boot to validate the material, which makes this module the leaf of that
 * relationship — importing configuration would make it a cycle. Same shape as
 * the key ring, same reason.
 */

/**
 * The permitted secret length, in bytes.
 *
 * The floor is 32 because the digest is SHA-256: a secret shorter than the
 * digest it produces is the weakest link in the construction, and 32 bytes from
 * a CSPRNG is what `openssl rand -base64 32` gives you.
 *
 * The ceiling is 64 because HMAC's block size for SHA-256 is 64 bytes, and the
 * construction *hashes any longer key down to 32* before using it. A 128-byte
 * secret therefore carries exactly the strength of its SHA-256 digest and not a
 * bit more, while looking to whoever pasted it like twice the security. Two
 * distinct 128-byte secrets could even collide into one effective key. Rejecting
 * the input is better than silently truncating its meaning.
 */
export const MIN_SECRET_BYTES = 32;
export const MAX_SECRET_BYTES = 64;

/**
 * The charset and length a key id may use.
 *
 * The id travels in the clear in every signature header and is quoted back in
 * logs on both sides, so it is an interoperability identifier rather than a
 * label to be edited: keep it short and boring, `2026-09` or `k3`. The charset
 * is restricted to what can appear in the header's comma/equals-delimited
 * parameter list without escaping, which is what lets the parser stay a split
 * rather than a grammar.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

/** A parsed entry: an id somebody chose and the secret bytes behind it. */
export interface WebhookSigningSecret {
  readonly id: string;
  readonly secret: Buffer;
}

export interface WebhookSigningSecretRing {
  /** The id outbound deliveries are signed under. */
  readonly activeKeyId: string;
  /** The secret outbound deliveries are signed with. */
  active(): WebhookSigningSecret;
  /** The secret a presented key id names, or `undefined` if it is not held. */
  find(keyId: string): WebhookSigningSecret | undefined;
  /** Every id held, in the order the spec listed them. Ids only — never bytes. */
  ids(): readonly string[];
}

/**
 * Thrown for a ring that cannot be used.
 *
 * Deliberately not an `AppError`, for the reason `KeyringError` is not one: this
 * is a configuration fault that must stop the boot, and giving it a status code
 * makes it catchable somewhere by somebody carrying on with signing quietly
 * broken.
 *
 * Every message below names the offending *entry* and never its value. An error
 * string is the one place secret material reliably escapes a process — stdout,
 * the log shipper, whatever aggregates errors by message — and a config error is
 * exactly the moment somebody is pasting secrets around.
 */
export class WebhookSigningSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSigningSecretError';
    Error.captureStackTrace(this, this.constructor);
  }
}

function parseEntry(raw: string, position: number): WebhookSigningSecret {
  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new WebhookSigningSecretError(
      `entry ${position} is not in "<key-id>:<base64-secret>" form ` +
        '(no ":" separating an id from its secret)',
    );
  }

  const id = raw.slice(0, separator);
  if (!KEY_ID_PATTERN.test(id)) {
    throw new WebhookSigningSecretError(
      `entry ${position} has key id "${id}", which is not 1-32 characters of [A-Za-z0-9_.-]`,
    );
  }

  const encoded = raw.slice(separator + 1);
  // `Buffer.from(s, 'base64')` does not fail on rubbish — it decodes what it can
  // and stops — so "not base64 at all" would otherwise arrive below as a length
  // complaint about a secret that was never a secret. Re-encoding and comparing
  // is the check Node does not provide; it is also why the length assertion
  // afterwards means what it says.
  const secret = Buffer.from(encoded, 'base64');
  if (secret.toString('base64') !== encoded) {
    throw new WebhookSigningSecretError(`entry ${position} ("${id}") is not valid base64`);
  }
  if (secret.length < MIN_SECRET_BYTES || secret.length > MAX_SECRET_BYTES) {
    throw new WebhookSigningSecretError(
      `entry ${position} ("${id}") decodes to ${secret.length} bytes; ` +
        `HMAC-SHA256 secrets here must be ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} bytes`,
    );
  }

  return { id, secret };
}

/**
 * Parse `WEBHOOK_SIGNING_SECRETS` — `id:base64,id:base64,…` — and pick the
 * active entry out of it.
 *
 * Pure, and exported for `@/config/env` to run at boot. A ring that is going to
 * be rejected should be rejected by the process that has not started serving
 * yet: the failure is identical whether it is found here or by the first
 * delivery that arrives, and only one of those is cheap to notice.
 */
export function parseWebhookSigningSecrets(
  spec: string,
  activeKeyId: string,
): WebhookSigningSecretRing {
  const entries = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new WebhookSigningSecretError('holds no entries');
  }

  const byId = new Map<string, WebhookSigningSecret>();
  const order: string[] = [];

  entries.forEach((raw, index) => {
    const entry = parseEntry(raw, index + 1);
    if (byId.has(entry.id)) {
      // Not tolerated even when the two entries carry identical bytes. A
      // duplicate id means somebody's rotation went wrong, and the two readings
      // available — "the same secret twice" and "two secrets, one id, last one
      // wins" — differ by which deliveries verify. Silently picking either makes
      // a verification failure depend on list order, which is not a thing anyone
      // thinks to look at.
      throw new WebhookSigningSecretError(`declares key id "${entry.id}" more than once`);
    }
    byId.set(entry.id, entry);
    order.push(entry.id);
  });

  const active = byId.get(activeKeyId);
  if (active === undefined) {
    throw new WebhookSigningSecretError(
      `names active key id "${activeKeyId}", which the ring does not hold ` +
        `(it holds: ${order.join(', ')})`,
    );
  }

  const ids: readonly string[] = Object.freeze([...order]);

  return {
    activeKeyId,
    active: () => active,
    find: (keyId: string) => byId.get(keyId),
    ids: () => ids,
  };
}
