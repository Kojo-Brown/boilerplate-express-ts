import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  DATA_KEY_BYTES,
  ENVELOPE_FORMAT_VERSION,
  IV_BYTES,
  decodeEnvelope,
  encodeEnvelope,
} from '@/crypto/envelope';
import type { Envelope } from '@/crypto/envelope';
import type { Keyring } from '@/crypto/keyring';

/**
 * Envelope encryption for individual column values: AES-256-GCM under a data
 * key that exists for one value, with that data key stored beside the
 * ciphertext, wrapped under a key-encryption key from `@/crypto/keyring`.
 *
 * Two keys instead of one is not ceremony. Encrypting a whole column under a
 * single key means that key is in memory for every read, in every backup of
 * every row, and bounded by GCM's own arithmetic: with random 96-bit nonces the
 * safe limit is ~2^32 messages *under one key*, and a column of user records
 * can reach that. A key used once has no nonce-collision budget to spend and no
 * blast radius — compromising it reveals that one field.
 *
 * And rotation stops being a migration. The key-encryption key protects 32-byte
 * data keys, so rotating it rewrites 32 bytes per row (`rewrap`) rather than
 * decrypting and re-encrypting every value; the payload, which is the large and
 * slow part, is never touched and its data key never changes.
 *
 * What this is not: searchable. A fresh key and nonce per value means two equal
 * plaintexts encrypt to unrelated bytes, so `WHERE phone_encrypted = $1` cannot
 * work and no index on the column is useful. That is the property that makes it
 * safe, not a gap to be patched — a field you must look up by value needs a
 * blind index (a keyed HMAC in its own column, which leaks equality by design
 * and is a decision to take deliberately). See `docs/field-encryption.md`.
 */

/**
 * What a ciphertext is bound to: the exact place it is allowed to live.
 *
 * GCM authenticates this alongside the payload, so an envelope only opens in
 * the table, column and row it was written for. Without it, anyone who can
 * write to the database — a compromised admin tool, SQL injection reaching an
 * UPDATE, a botched data fix — can copy one user's encrypted value into another
 * user's row, and the application will decrypt it and serve it as that user's
 * own. Nothing in the ciphertext knows any different: it is authentic, it is
 * intact, and it is in the wrong row. Binding it makes that a decryption
 * failure instead.
 *
 * The `id` is the row's primary key, which is why the encrypted tables here are
 * keyed by an id the caller already holds: the context has to be known *before*
 * the insert, and a database-generated key is not.
 */
export interface FieldContext {
  readonly table: string;
  readonly column: string;
  readonly id: string;
}

export interface FieldCipher {
  /** Encrypt a value under a fresh data key bound to `context`. */
  encrypt(plaintext: string | Buffer, context: FieldContext): Buffer;
  /** Decrypt bytes from the column, as bytes. Throws unless everything matches. */
  decrypt(stored: Buffer, context: FieldContext): Buffer;
  /** `decrypt`, decoded as UTF-8 — what every string column wants. */
  decryptText(stored: Buffer, context: FieldContext): string;
  /**
   * Re-wrap the data key under the ring's active key, leaving the payload
   * exactly as it is. The rewrapped envelope decrypts to the same plaintext.
   */
  rewrap(stored: Buffer, context: FieldContext): Buffer;
  /** Whether `stored` is wrapped under something other than the active key. */
  needsRewrap(stored: Buffer): boolean;
}

/**
 * Thrown when an envelope does not open: unknown key id, failed tag, or a
 * context that does not match the one it was sealed with.
 *
 * The message says which of those it was and never says more. A decryption
 * oracle is built out of detailed failures, and the operator's version of the
 * detail — which row, which column — is in the context the caller already has.
 * Like `KeyringError`, deliberately not an `AppError`: "the stored value did
 * not authenticate" is never a 4xx to be handed back to whoever asked.
 */
export class FieldDecryptionError extends Error {
  constructor(message: string) {
    super(`encrypted field did not decrypt: ${message}`);
    this.name = 'FieldDecryptionError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * The context, canonically serialised for use as additional authenticated data.
 *
 * NUL-separated, and NUL is therefore forbidden inside the parts. Without that
 * rule the separator is ambiguous: `{table: 'a', column: 'b\0c'}` and
 * `{table: 'a\0b', column: 'c'}` serialise identically, so a value written for
 * one could be moved into the other — which is precisely the substitution the
 * context exists to prevent. Empty parts are refused for the same reason: a
 * context is only a binding if it is fully specified, and an empty `id` binds a
 * value to every row at once.
 */
export function encodeFieldContext(context: FieldContext): Buffer {
  const parts: readonly [string, string][] = [
    ['table', context.table],
    ['column', context.column],
    ['id', context.id],
  ];
  for (const [name, value] of parts) {
    if (value.length === 0) {
      throw new FieldDecryptionError(`context.${name} is empty`);
    }
    if (value.includes('\u0000')) {
      throw new FieldDecryptionError(`context.${name} contains a NUL byte`);
    }
  }
  return Buffer.from(`${context.table}\u0000${context.column}\u0000${context.id}`, 'utf8');
}

/**
 * Domain separation between the two GCM operations in one envelope.
 *
 * The data key is wrapped with the same algorithm and the same context as the
 * payload it protects. Tagging each with what it is stops any construction in
 * which one is presented to the other's decrypt — the tag is computed over a
 * different string, so a wrapped key offered as a payload simply fails.
 *
 * The format version and key id ride along in the wrap's data, which is what
 * makes the header authenticated rather than decorative: an attacker editing
 * the stored key id to name a weaker key, or the version byte to select a
 * future parser, changes the additional data and breaks the tag.
 */
function wrapAad(keyId: string, context: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`dek\u0000${ENVELOPE_FORMAT_VERSION}\u0000${keyId}\u0000`, 'utf8'),
    context,
  ]);
}

function payloadAad(context: Buffer): Buffer {
  return Buffer.concat([Buffer.from('field\u0000', 'utf8'), context]);
}

export function createFieldCipher(keyring: Keyring): FieldCipher {
  /** Wrap a data key under a key-ring entry. Shared by `encrypt` and `rewrap`. */
  function wrapDataKey(
    dataKey: Buffer,
    context: Buffer,
  ): Pick<Envelope, 'keyId' | 'wrapIv' | 'wrapTag' | 'wrappedKey'> {
    const { id, key } = keyring.active();
    const wrapIv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, wrapIv);
    cipher.setAAD(wrapAad(id, context));
    const wrappedKey = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return { keyId: id, wrapIv, wrapTag: cipher.getAuthTag(), wrappedKey };
  }

  function unwrapDataKey(envelope: Envelope, context: Buffer): Buffer {
    const entry = keyring.find(envelope.keyId);
    if (!entry) {
      // Named, because this one is an operations error with an obvious fix:
      // the ring retired a key that rows still reference. The id is not a
      // secret — it is stored in the clear in every row it wrote.
      throw new FieldDecryptionError(
        `it names key "${envelope.keyId}", which this deployment's key ring does not hold`,
      );
    }

    const decipher = createDecipheriv('aes-256-gcm', entry.key, envelope.wrapIv);
    decipher.setAAD(wrapAad(envelope.keyId, context));
    decipher.setAuthTag(envelope.wrapTag);
    let dataKey: Buffer;
    try {
      dataKey = Buffer.concat([decipher.update(envelope.wrappedKey), decipher.final()]);
    } catch {
      // The original error is swallowed on purpose: OpenSSL's message is
      // "Unsupported state or unable to authenticate data", which tells a
      // reader nothing and tells anyone probing exactly where they got to.
      throw new FieldDecryptionError(
        'the wrapped data key failed authentication — wrong key, wrong row, or altered bytes',
      );
    }

    if (dataKey.length !== DATA_KEY_BYTES) {
      throw new FieldDecryptionError(
        `the unwrapped data key is ${dataKey.length} bytes, not ${DATA_KEY_BYTES}`,
      );
    }
    return dataKey;
  }

  /**
   * Named rather than written inline in the returned object, because
   * `decryptText` calls it. Through `this` that call would break the moment a
   * caller destructured the cipher (`const { decryptText } = cipher`), which is
   * exactly how a repository tends to hold one.
   */
  function decryptField(stored: Buffer, context: FieldContext): Buffer {
    const aad = encodeFieldContext(context);
    const envelope = decodeEnvelope(stored);
    const dataKey = unwrapDataKey(envelope, aad);

    const decipher = createDecipheriv('aes-256-gcm', dataKey, envelope.iv);
    decipher.setAAD(payloadAad(aad));
    decipher.setAuthTag(envelope.tag);
    try {
      return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
      throw new FieldDecryptionError(
        'the payload failed authentication — the stored bytes have been altered',
      );
    } finally {
      dataKey.fill(0);
    }
  }

  return {
    encrypt(plaintext: string | Buffer, context: FieldContext): Buffer {
      const aad = encodeFieldContext(context);
      // One key, one value, one nonce. Both are from `randomBytes` — a counter
      // would be better arithmetic and worse operations, because it has to be
      // durable across restarts and across every instance, and a counter that
      // is reused after a rollback destroys GCM's confidentiality *and* its
      // authentication.
      const dataKey = randomBytes(DATA_KEY_BYTES);
      const iv = randomBytes(IV_BYTES);

      const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
      cipher.setAAD(payloadAad(aad));
      const ciphertext = Buffer.concat([
        cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
        cipher.final(),
      ]);

      const encoded = encodeEnvelope({
        ...wrapDataKey(dataKey, aad),
        iv,
        tag: cipher.getAuthTag(),
        ciphertext,
      });
      // The data key's whole life is this function. Zeroing it does not make
      // the process safe — V8 has copied the buffer's contents nowhere we can
      // reach — but it does keep the one reference we control from sitting in
      // a heap dump for as long as the garbage collector feels like it.
      dataKey.fill(0);
      return encoded;
    },

    decrypt: decryptField,

    decryptText(stored: Buffer, context: FieldContext): string {
      return decryptField(stored, context).toString('utf8');
    },

    rewrap(stored: Buffer, context: FieldContext): Buffer {
      const aad = encodeFieldContext(context);
      const envelope = decodeEnvelope(stored);
      const dataKey = unwrapDataKey(envelope, aad);
      try {
        // Payload, nonce and tag are carried across untouched. Re-encrypting
        // the value here would be the mistake that makes key rotation an
        // operation people postpone: it turns a 32-byte rewrite per row into
        // reading, decrypting and re-encrypting every byte of every field,
        // which on a large table is the difference between minutes and a
        // maintenance window.
        return encodeEnvelope({
          ...wrapDataKey(dataKey, aad),
          iv: envelope.iv,
          tag: envelope.tag,
          ciphertext: envelope.ciphertext,
        });
      } finally {
        dataKey.fill(0);
      }
    },

    needsRewrap(stored: Buffer): boolean {
      // A plain comparison: the key id is stored in the clear and is not a
      // secret, so there is nothing here for a timing comparison to protect.
      return decodeEnvelope(stored).keyId !== keyring.activeKeyId;
    },
  };
}
