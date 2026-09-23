import { randomBytes } from 'node:crypto';
import {
  DATA_KEY_BYTES,
  ENVELOPE_FORMAT_VERSION,
  EnvelopeFormatError,
  IV_BYTES,
  TAG_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  envelopeKeyId,
} from '@/crypto/envelope';
import type { Envelope } from '@/crypto/envelope';

function anEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    keyId: 'k1',
    wrapIv: randomBytes(IV_BYTES),
    wrapTag: randomBytes(TAG_BYTES),
    wrappedKey: randomBytes(DATA_KEY_BYTES),
    iv: randomBytes(IV_BYTES),
    tag: randomBytes(TAG_BYTES),
    ciphertext: randomBytes(24),
    ...overrides,
  };
}

describe('envelope encoding', () => {
  it('round-trips every field', () => {
    const envelope = anEnvelope();
    const decoded = decodeEnvelope(encodeEnvelope(envelope));

    expect(decoded.keyId).toBe(envelope.keyId);
    expect(decoded.wrapIv).toEqual(envelope.wrapIv);
    expect(decoded.wrapTag).toEqual(envelope.wrapTag);
    expect(decoded.wrappedKey).toEqual(envelope.wrappedKey);
    expect(decoded.iv).toEqual(envelope.iv);
    expect(decoded.tag).toEqual(envelope.tag);
    expect(decoded.ciphertext).toEqual(envelope.ciphertext);
  });

  it('round-trips an empty payload', () => {
    // An empty string is a value a user can enter, and GCM is perfectly happy
    // to authenticate zero bytes. A format that could not carry it would turn
    // "" into a decode failure on read.
    const decoded = decodeEnvelope(encodeEnvelope(anEnvelope({ ciphertext: Buffer.alloc(0) })));
    expect(decoded.ciphertext).toHaveLength(0);
  });

  it('writes the format version first, where a reader can find it', () => {
    const bytes = encodeEnvelope(anEnvelope());
    expect(bytes.readUInt8(0)).toBe(ENVELOPE_FORMAT_VERSION);
  });

  it('lays out a known envelope byte for byte', () => {
    // Pinned deliberately. Every row already written is readable only for as
    // long as this layout holds, so a change to it has to be a change to this
    // test — which is the moment to remember that the version byte exists and
    // that old rows still need a reader.
    const bytes = encodeEnvelope({
      keyId: 'k1',
      wrapIv: Buffer.alloc(IV_BYTES, 0x11),
      wrapTag: Buffer.alloc(TAG_BYTES, 0x22),
      wrappedKey: Buffer.alloc(DATA_KEY_BYTES, 0x33),
      iv: Buffer.alloc(IV_BYTES, 0x44),
      tag: Buffer.alloc(TAG_BYTES, 0x55),
      ciphertext: Buffer.from('ab', 'utf8'),
    });

    expect(bytes.subarray(0, 4).toString('hex')).toBe('01026b31');
    expect(bytes).toHaveLength(2 + 2 + IV_BYTES + TAG_BYTES + DATA_KEY_BYTES + IV_BYTES + TAG_BYTES + 2);
  });

  it('reads the key id without unwrapping anything', () => {
    // What a rotation scan uses: deciding whether a row is stale must not
    // require the key that row was written under.
    expect(envelopeKeyId(encodeEnvelope(anEnvelope({ keyId: '2026-09' })))).toBe('2026-09');
  });

  it('refuses a key id that would not survive the length byte', () => {
    expect(() => encodeEnvelope(anEnvelope({ keyId: 'k'.repeat(256) }))).toThrow(
      EnvelopeFormatError,
    );
    expect(() => encodeEnvelope(anEnvelope({ keyId: '' }))).toThrow(/1-255 bytes/);
  });

  it('refuses a format version it was not written to read', () => {
    // Not "read it anyway and hope": a future format may put different things
    // in these offsets, and guessing produces a plausible plaintext from the
    // wrong bytes rather than an error.
    const bytes = encodeEnvelope(anEnvelope());
    bytes.writeUInt8(2, 0);

    expect(() => decodeEnvelope(bytes)).toThrow(/format version 2 is not supported/);
  });

  it('refuses a truncated value instead of slicing short buffers out of it', () => {
    // `Buffer.subarray` clamps rather than throwing, so without the length
    // checks a column that lost its tail decodes into a short IV and fails
    // much later, inside the cipher, with a message about authentication.
    const bytes = encodeEnvelope(anEnvelope());

    expect(() => decodeEnvelope(bytes.subarray(0, 20))).toThrow(EnvelopeFormatError);
    expect(() => decodeEnvelope(bytes.subarray(0, 20))).toThrow(/cannot hold/);
    expect(() => decodeEnvelope(Buffer.alloc(1))).toThrow(/shorter than the header/);
  });

  it('refuses an empty key id in stored bytes', () => {
    const bytes = encodeEnvelope(anEnvelope());
    bytes.writeUInt8(0, 1);

    expect(() => decodeEnvelope(bytes)).toThrow(/key id is empty/);
  });
});
