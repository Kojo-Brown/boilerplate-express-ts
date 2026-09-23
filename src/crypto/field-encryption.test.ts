import { env } from '@/config/env';
import { getFieldCipher, getFieldKeyring, resetFieldCipher } from '@/crypto/field-encryption';

const context = { table: 'user_pii', column: 'phone_encrypted', id: 'user-1' };

afterEach(() => {
  resetFieldCipher();
});

describe('the process-wide field cipher', () => {
  it('is built from the ring the configuration names', () => {
    const keyring = getFieldKeyring();

    expect(keyring.activeKeyId).toBe(env.FIELD_ENCRYPTION_ACTIVE_KEY_ID);
    expect(keyring.ids()).toEqual(['test-1', 'test-2']);
  });

  it('is the same cipher every time, not a new ring per call', () => {
    // A getter that re-parsed on every call would re-derive the key material
    // on every field written — and, because `env` is frozen, would derive
    // exactly the same thing each time. All cost, no difference.
    expect(getFieldCipher()).toBe(getFieldCipher());
    expect(getFieldKeyring()).toBe(getFieldKeyring());
  });

  it('encrypts under the configured active key', () => {
    const stored = getFieldCipher().encrypt('+15550000000', context);

    expect(getFieldCipher().needsRewrap(stored)).toBe(false);
    expect(getFieldCipher().decryptText(stored, context)).toBe('+15550000000');
  });

  it('keeps reading what it wrote after a reset', () => {
    // `resetFieldCipher` exists for tests that drive configuration. It must not
    // be a way to lose data: the ring is rebuilt from the same environment, so
    // a value written before the reset opens after it.
    const stored = getFieldCipher().encrypt('+15550000000', context);
    resetFieldCipher();

    expect(getFieldCipher().decryptText(stored, context)).toBe('+15550000000');
  });
});
