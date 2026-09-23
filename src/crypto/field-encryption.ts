import { env } from '@/config/env';
import { createFieldCipher } from '@/crypto/field-cipher';
import type { FieldCipher } from '@/crypto/field-cipher';
import { parseKeyring } from '@/crypto/keyring';
import type { Keyring } from '@/crypto/keyring';

/**
 * The process-wide cipher, built from configuration on first use.
 *
 * Lazy rather than built at import, and memoised rather than rebuilt: parsing
 * the ring allocates the key material, and a module that does that at import
 * time does it in every test file that transitively imports it, whether or not
 * anything encrypts. The configuration has already been validated at boot by
 * `@/config/env`, so this can only fail here if it could also have failed
 * there — which is the property that makes the laziness safe.
 *
 * Note what is *not* here: a null cipher for when no keys are configured. The
 * keys are required configuration, so the "encryption quietly disabled in
 * production because an environment variable was missing" branch does not
 * exist to be taken. See `docs/field-encryption.md`.
 */
let cipher: FieldCipher | undefined;
let keyring: Keyring | undefined;

export function getFieldKeyring(): Keyring {
  keyring ??= parseKeyring(env.FIELD_ENCRYPTION_KEYS, env.FIELD_ENCRYPTION_ACTIVE_KEY_ID);
  return keyring;
}

export function getFieldCipher(): FieldCipher {
  cipher ??= createFieldCipher(getFieldKeyring());
  return cipher;
}

/**
 * Drop the memoised cipher.
 *
 * For tests that drive configuration, and for nothing else: a running process
 * has no reason to rebuild its key ring, and `env` is frozen, so there is
 * nothing for it to pick up.
 */
export function resetFieldCipher(): void {
  cipher = undefined;
  keyring = undefined;
}
