import { createHash, randomBytes } from 'crypto';

/** Bytes of entropy behind every generated secret. 256 bits. */
const SECRET_BYTES = 32;

/**
 * Mints an opaque, URL-safe secret: a magic-link token or an API key.
 *
 * `base64url` rather than hex so the value survives a query string and an email
 * client's line wrapping without escaping, at 43 characters instead of 64.
 */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * The digest a magic-link token or API key is stored under.
 *
 * A single SHA-256 is the right primitive here, and reaching for argon2 — as
 * `lib/password` correctly does for passwords — would be a mistake. A password
 * KDF is slow in order to make guessing a *low-entropy, human-chosen* string
 * expensive. These secrets carry 256 bits of entropy from a CSPRNG, so there is
 * no guessing attack to slow down; all a KDF would buy is tens of milliseconds
 * of CPU on every request that presents one. What the hash is actually for is
 * that a leaked dump of the store contains no usable credential, and SHA-256
 * delivers that in full.
 *
 * Lookups are by digest, never by scanning, so the comparison is a hash-table
 * probe rather than a string compare and there is no timing channel to close.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
