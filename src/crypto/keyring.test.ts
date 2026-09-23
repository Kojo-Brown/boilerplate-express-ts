import { randomBytes } from 'node:crypto';
import { KeyringError, parseKeyring } from '@/crypto/keyring';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

describe('parseKeyring', () => {
  it('parses a single entry and makes it active', () => {
    const keyring = parseKeyring(`k1:${KEY_A}`, 'k1');

    expect(keyring.activeKeyId).toBe('k1');
    expect(keyring.active().id).toBe('k1');
    expect(keyring.active().key).toHaveLength(32);
    expect(keyring.ids()).toEqual(['k1']);
  });

  it('holds retired keys alongside the active one', () => {
    // The state a rotation spends most of its life in: the old key is no
    // longer written under, and every row written before the switch still
    // needs it. A ring that dropped it would turn those rows into 500s.
    const keyring = parseKeyring(`k1:${KEY_A},k2:${KEY_B}`, 'k2');

    expect(keyring.activeKeyId).toBe('k2');
    expect(keyring.find('k1')?.key.toString('base64')).toBe(KEY_A);
    expect(keyring.find('k2')?.key.toString('base64')).toBe(KEY_B);
    expect(keyring.ids()).toEqual(['k1', 'k2']);
  });

  it('tolerates whitespace around entries', () => {
    // Keys are pasted into deployment configuration by hand often enough that
    // a leading space should not be an outage.
    const keyring = parseKeyring(` k1:${KEY_A} , k2:${KEY_B} `, 'k1');
    expect(keyring.ids()).toEqual(['k1', 'k2']);
  });

  it('returns undefined for a key it does not hold', () => {
    const keyring = parseKeyring(`k1:${KEY_A}`, 'k1');
    expect(keyring.find('k9')).toBeUndefined();
  });

  it('rejects an active id the ring does not hold', () => {
    // The mistake that breaks the second phase of a rotation: the active id
    // is advanced before the key itself has been deployed. Caught at boot,
    // this is a deployment that does not start; missed, it is every write
    // failing.
    expect(() => parseKeyring(`k1:${KEY_A}`, 'k2')).toThrow(KeyringError);
    expect(() => parseKeyring(`k1:${KEY_A}`, 'k2')).toThrow(/does not hold/);
  });

  it('rejects an empty ring', () => {
    expect(() => parseKeyring('', 'k1')).toThrow(/holds no keys/);
    expect(() => parseKeyring('  ,  ', 'k1')).toThrow(/holds no keys/);
  });

  it('rejects duplicate ids', () => {
    // Ids are what a stored ciphertext names. Two keys sharing one would make
    // "which key opens this row" depend on parse order.
    expect(() => parseKeyring(`k1:${KEY_A},k1:${KEY_B}`, 'k1')).toThrow(/two keys with id "k1"/);
  });

  it('rejects an entry with no separator', () => {
    expect(() => parseKeyring(KEY_A, 'k1')).toThrow(/not in "<key-id>:<base64-key>" form/);
  });

  it('rejects an entry with an empty id', () => {
    expect(() => parseKeyring(`:${KEY_A}`, '')).toThrow(/not in "<key-id>:<base64-key>" form/);
  });

  it('rejects a key id outside the persisted charset', () => {
    // The id goes into every envelope this key writes, so it is a persisted
    // identifier: bounded length, ASCII, no separator characters.
    expect(() => parseKeyring(`k 1:${KEY_A}`, 'k 1')).toThrow(/not 1-32 characters/);
    expect(() => parseKeyring(`${'k'.repeat(33)}:${KEY_A}`, 'k')).toThrow(/not 1-32 characters/);
  });

  it('rejects a key that is not base64 rather than silently truncating it', () => {
    // `Buffer.from(s, 'base64')` decodes what it can and stops. Without the
    // round-trip check, "not base64 at all" arrives as a short key and is
    // reported as a length problem — or, for the right rubbish, as a 32-byte
    // key nobody chose.
    expect(() => parseKeyring('k1:not base64 at all!!', 'k1')).toThrow(/not valid base64/);
  });

  it('rejects a key that is not 32 bytes', () => {
    const short = randomBytes(16).toString('base64');
    const long = randomBytes(64).toString('base64');

    expect(() => parseKeyring(`k1:${short}`, 'k1')).toThrow(/decodes to 16 bytes/);
    expect(() => parseKeyring(`k1:${long}`, 'k1')).toThrow(/decodes to 64 bytes/);
  });

  it('never puts key material in an error message', () => {
    // A config error is exactly when somebody is pasting keys around, and an
    // error message is the one place secrets reliably escape a process: it
    // goes to stdout, to the log shipper, and into whatever groups errors by
    // message.
    const short = randomBytes(16).toString('base64');
    let message = '';
    try {
      parseKeyring(`k1:${KEY_A},k2:${short}`, 'k1');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('k2');
    expect(message).not.toContain(short);
    expect(message).not.toContain(KEY_A);
  });
});
