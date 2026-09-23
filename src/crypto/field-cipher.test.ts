import { randomBytes } from 'node:crypto';
import { decodeEnvelope, encodeEnvelope } from '@/crypto/envelope';
import {
  FieldDecryptionError,
  createFieldCipher,
  encodeFieldContext,
} from '@/crypto/field-cipher';
import type { FieldContext } from '@/crypto/field-cipher';
import { parseKeyring } from '@/crypto/keyring';

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const OTHER_DEPLOYMENT_KEY = randomBytes(32).toString('base64');

const ring = parseKeyring(`k1:${KEY_1}`, 'k1');
const rotatedRing = parseKeyring(`k1:${KEY_1},k2:${KEY_2}`, 'k2');
const retiredRing = parseKeyring(`k2:${KEY_2}`, 'k2');
const foreignRing = parseKeyring(`k1:${OTHER_DEPLOYMENT_KEY}`, 'k1');

const cipher = createFieldCipher(ring);

const context: FieldContext = { table: 'user_pii', column: 'phone_encrypted', id: 'user-1' };
const PHONE = '+15550000000';

describe('field cipher', () => {
  it('round-trips a value', () => {
    expect(cipher.decryptText(cipher.encrypt(PHONE, context), context)).toBe(PHONE);
  });

  it('round-trips bytes and an empty string', () => {
    const bytes = randomBytes(64);
    expect(cipher.decrypt(cipher.encrypt(bytes, context), context)).toEqual(bytes);
    expect(cipher.decryptText(cipher.encrypt('', context), context)).toBe('');
  });

  it('round-trips multi-byte text at its byte length, not its character count', () => {
    // The UTF-8 detail that a `Buffer.alloc(plaintext.length)` implementation
    // gets wrong and a round trip through ASCII fixtures never catches.
    const value = '東京都新宿区 — 🗼';
    expect(cipher.decryptText(cipher.encrypt(value, context), context)).toBe(value);
  });

  it('keeps no plaintext in the stored bytes', () => {
    const stored = cipher.encrypt(PHONE, context);
    expect(stored.includes(Buffer.from(PHONE, 'utf8'))).toBe(false);
  });

  it('produces unrelated ciphertexts for the same plaintext', () => {
    // The property that makes `WHERE phone_encrypted = $1` impossible, which
    // is the point: equal ciphertexts would leak equality across every row of
    // the column to anyone holding a backup. A field that must be looked up by
    // value needs a blind index instead — see docs/field-encryption.md.
    const a = cipher.encrypt(PHONE, context);
    const b = cipher.encrypt(PHONE, context);

    expect(a.equals(b)).toBe(false);
    expect(decodeEnvelope(a).wrappedKey.equals(decodeEnvelope(b).wrappedKey)).toBe(false);
    expect(decodeEnvelope(a).iv.equals(decodeEnvelope(b).iv)).toBe(false);
  });

  it('uses a fresh data key per value, so one recovered key opens one field', () => {
    const first = decodeEnvelope(cipher.encrypt(PHONE, context));
    const second = decodeEnvelope(cipher.encrypt(PHONE, context));

    // Wrapped under the same key-encryption key, but different data keys: the
    // wrap nonces differ too, which is what keeps the wraps themselves safe.
    expect(first.keyId).toBe('k1');
    expect(second.keyId).toBe('k1');
    expect(first.wrapIv.equals(second.wrapIv)).toBe(false);
  });

  it('refuses a value moved to another row', () => {
    // The attack the context exists for. Anyone who can write to the database
    // — a compromised admin tool, an injection reaching an UPDATE, a careless
    // data fix — can copy one user's ciphertext into another user's row.
    // Without binding, the application decrypts it and serves one user's phone
    // number as another's, and every check passes: the bytes are authentic and
    // intact, just in the wrong place.
    const stored = cipher.encrypt(PHONE, context);

    expect(() => cipher.decryptText(stored, { ...context, id: 'user-2' })).toThrow(
      FieldDecryptionError,
    );
  });

  it('refuses a value moved to another column of the same row', () => {
    const stored = cipher.encrypt(PHONE, context);
    expect(() => cipher.decryptText(stored, { ...context, column: 'address_encrypted' })).toThrow(
      FieldDecryptionError,
    );
  });

  it('refuses a value moved to another table', () => {
    const stored = cipher.encrypt(PHONE, context);
    expect(() => cipher.decryptText(stored, { ...context, table: 'staff_pii' })).toThrow(
      FieldDecryptionError,
    );
  });

  it('refuses a flipped bit in the payload', () => {
    const stored = cipher.encrypt(PHONE, context);
    const last = stored.length - 1;
    stored.writeUInt8(stored.readUInt8(last) ^ 0x01, last);

    expect(() => cipher.decryptText(stored, context)).toThrow(/payload failed authentication/);
  });

  it('refuses a flipped bit in the wrapped data key', () => {
    const stored = cipher.encrypt(PHONE, context);
    const envelope = decodeEnvelope(stored);
    const tampered = Buffer.from(envelope.wrappedKey);
    tampered.writeUInt8(tampered.readUInt8(0) ^ 0x01, 0);

    expect(() =>
      cipher.decryptText(encodeEnvelope({ ...envelope, wrappedKey: tampered }), context),
    ).toThrow(/wrapped data key failed authentication/);
  });

  it('refuses an edited key id, because the header is authenticated too', () => {
    // The header is in the wrap's additional data, so relabelling a row to
    // name a different key — a weaker one, or one an attacker knows — breaks
    // the tag rather than selecting that key.
    const rotatedCipher = createFieldCipher(rotatedRing);
    const stored = rotatedCipher.encrypt(PHONE, context);
    const envelope = decodeEnvelope(stored);

    expect(() =>
      rotatedCipher.decryptText(encodeEnvelope({ ...envelope, keyId: 'k1' }), context),
    ).toThrow(FieldDecryptionError);
  });

  it('refuses a value written by another deployment', () => {
    // Same key id, different key bytes: a restore into the wrong environment,
    // which otherwise fails somewhere far from the restore.
    const stored = cipher.encrypt(PHONE, context);

    expect(() => createFieldCipher(foreignRing).decryptText(stored, context)).toThrow(
      /failed authentication/,
    );
  });

  it('says so plainly when the ring no longer holds the key a row names', () => {
    // The rotation mistake with an obvious fix: the old key was retired before
    // `rotate-field-keys` finished. The message names the key id, which is
    // stored in the clear in every row it wrote and is not a secret.
    const stored = cipher.encrypt(PHONE, context);

    expect(() => createFieldCipher(retiredRing).decryptText(stored, context)).toThrow(
      /names key "k1", which this deployment's key ring does not hold/,
    );
  });

  it('never repeats the plaintext or the context in a failure message', () => {
    const stored = cipher.encrypt(PHONE, context);
    let message = '';
    try {
      cipher.decryptText(stored, { ...context, id: 'user-2' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('failed authentication');
    expect(message).not.toContain(PHONE);
    expect(message).not.toContain('user-2');
  });
});

describe('field cipher rewrap', () => {
  it('re-wraps under the active key and leaves the payload untouched', () => {
    // The whole reason for two keys: rotating the key-encryption key rewrites
    // 32 bytes per row, not every byte of every value.
    const rotatedCipher = createFieldCipher(rotatedRing);
    const stored = createFieldCipher(ring).encrypt(PHONE, context);
    const before = decodeEnvelope(stored);

    const rewrapped = rotatedCipher.rewrap(stored, context);
    const after = decodeEnvelope(rewrapped);

    expect(after.keyId).toBe('k2');
    expect(after.ciphertext.equals(before.ciphertext)).toBe(true);
    expect(after.iv.equals(before.iv)).toBe(true);
    expect(after.tag.equals(before.tag)).toBe(true);
    // The wrap itself is new: a fresh nonce, and therefore a fresh tag.
    expect(after.wrapIv.equals(before.wrapIv)).toBe(false);
    expect(after.wrappedKey.equals(before.wrappedKey)).toBe(false);
  });

  it('leaves the value readable, by the new ring and not the old one', () => {
    const rotatedCipher = createFieldCipher(rotatedRing);
    const rewrapped = rotatedCipher.rewrap(createFieldCipher(ring).encrypt(PHONE, context), context);

    expect(rotatedCipher.decryptText(rewrapped, context)).toBe(PHONE);
    // The old ring holds only `k1`; the rewrapped row names `k2`. This is the
    // asymmetry that makes retiring a key a third deployment rather than part
    // of the second.
    expect(() => createFieldCipher(ring).decryptText(rewrapped, context)).toThrow(
      /does not hold/,
    );
  });

  it('still binds the context, so rewrapping cannot launder a moved value', () => {
    const stored = cipher.encrypt(PHONE, context);
    expect(() => createFieldCipher(rotatedRing).rewrap(stored, { ...context, id: 'user-2' })).toThrow(
      FieldDecryptionError,
    );
  });

  it('reports which rows a rotation pass has left to do', () => {
    const rotatedCipher = createFieldCipher(rotatedRing);
    const stale = createFieldCipher(ring).encrypt(PHONE, context);

    expect(rotatedCipher.needsRewrap(stale)).toBe(true);
    expect(rotatedCipher.needsRewrap(rotatedCipher.rewrap(stale, context))).toBe(false);
    // Idempotent: a second pass over an already-rotated table rewrites nothing.
    expect(rotatedCipher.needsRewrap(rotatedCipher.encrypt(PHONE, context))).toBe(false);
  });
});

describe('encodeFieldContext', () => {
  it('refuses a NUL byte in any part', () => {
    // NUL is the separator, so allowing it inside a part makes the encoding
    // ambiguous: {table: 'a', column: 'b\0c'} and {table: 'a\0b', column: 'c'}
    // would serialise identically, and a value written for one would decrypt
    // in the other — exactly the substitution the context prevents.
    expect(() => encodeFieldContext({ ...context, table: 'user\u0000pii' })).toThrow(/NUL/);
    expect(() => encodeFieldContext({ ...context, column: 'a\u0000b' })).toThrow(/NUL/);
    expect(() => encodeFieldContext({ ...context, id: 'a\u0000b' })).toThrow(/NUL/);
  });

  it('refuses an empty part', () => {
    // An empty id would bind a value to every row at once, which is the
    // failure the binding exists to prevent, arrived at by omission.
    expect(() => encodeFieldContext({ ...context, id: '' })).toThrow(/context.id is empty/);
    expect(() => encodeFieldContext({ ...context, table: '' })).toThrow(/context.table is empty/);
    expect(() => encodeFieldContext({ ...context, column: '' })).toThrow(/context.column is empty/);
  });

  it('distinguishes contexts that differ only in where the boundary falls', () => {
    const a = encodeFieldContext({ table: 'ab', column: 'c', id: 'd' });
    const b = encodeFieldContext({ table: 'a', column: 'bc', id: 'd' });
    expect(a.equals(b)).toBe(false);
  });
});
