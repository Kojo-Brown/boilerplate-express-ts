/**
 * The on-disk shape of an encrypted field, and nothing else: this module knows
 * how the bytes are laid out and does no cryptography.
 *
 * Separate from `@/crypto/field-cipher` because the format is the part that is
 * hard to change later. Every row written under it has to stay readable, so the
 * layout is versioned in its first byte and parsing refuses anything it was not
 * written to understand — a value from a future format is a value this build
 * must not guess at.
 *
 * Self-describing, because the alternative is columns of bytes whose meaning
 * lives in a deployment's configuration. A row must carry the key id that opens
 * it, or rotating a key becomes a rewrite of every table on a deadline, and a
 * restore of last month's backup into this month's fleet is unreadable data.
 */

/** The only format this build writes, and the only one it reads. */
export const ENVELOPE_FORMAT_VERSION = 1;

/** GCM's standard nonce size. 96 bits is what the mode is specified around. */
export const IV_BYTES = 12;
/** The full GCM tag. Truncating it is a supported option and a bad default. */
export const TAG_BYTES = 16;
/** The data key itself: AES-256, so 32 bytes, wrapped to the same length. */
export const DATA_KEY_BYTES = 32;

const VERSION_OFFSET = 0;
const KEY_ID_LENGTH_OFFSET = 1;
const HEADER_BYTES = 2;

/** Everything an envelope holds, decoded. */
export interface Envelope {
  /** Which key-ring entry wrapped `wrappedKey`. */
  readonly keyId: string;
  /** Nonce for the wrap of the data key under the key-encryption key. */
  readonly wrapIv: Buffer;
  /** GCM tag over the wrapped data key. */
  readonly wrapTag: Buffer;
  /** The data key, encrypted under the key-encryption key. */
  readonly wrappedKey: Buffer;
  /** Nonce for the payload, under the data key. */
  readonly iv: Buffer;
  /** GCM tag over the payload. */
  readonly tag: Buffer;
  /** The field value, encrypted under the data key. May be empty. */
  readonly ciphertext: Buffer;
}

/**
 * Thrown when bytes in an encrypted column are not a well-formed envelope.
 *
 * Distinct from the decryption failure in `@/crypto/field-cipher`, and the
 * distinction is operational rather than pedantic: this one says the column
 * holds something that was never written by this system — a truncating
 * migration, a text/bytea round trip through a tool that re-encoded it, a
 * restore from the wrong place. A failed tag says the bytes are ours and the
 * key or the context is wrong. Those lead to completely different mornings.
 */
export class EnvelopeFormatError extends Error {
  constructor(message: string) {
    super(`encrypted field is malformed: ${message}`);
    this.name = 'EnvelopeFormatError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Serialise an envelope to the bytes stored in a `bytea` column. */
export function encodeEnvelope(envelope: Envelope): Buffer {
  const keyId = Buffer.from(envelope.keyId, 'ascii');
  // Guaranteed by `parseKeyring`, asserted here because this module is what
  // makes it a persisted constraint: a longer id would not fit the length byte
  // and would be silently truncated into an id that opens nothing.
  if (keyId.length === 0 || keyId.length > 255) {
    throw new EnvelopeFormatError(`key id must be 1-255 bytes, got ${keyId.length}`);
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(ENVELOPE_FORMAT_VERSION, VERSION_OFFSET);
  header.writeUInt8(keyId.length, KEY_ID_LENGTH_OFFSET);

  return Buffer.concat([
    header,
    keyId,
    envelope.wrapIv,
    envelope.wrapTag,
    envelope.wrappedKey,
    envelope.iv,
    envelope.tag,
    envelope.ciphertext,
  ]);
}

/**
 * Parse stored bytes back into an envelope.
 *
 * Every length is checked before it is sliced. `Buffer.subarray` clamps rather
 * than throwing, so a truncated value would otherwise decode into short IVs and
 * tags and only fail later inside the cipher, where the message is about
 * authentication and the cause is a column that lost its tail.
 */
export function decodeEnvelope(bytes: Buffer): Envelope {
  if (bytes.length < HEADER_BYTES) {
    throw new EnvelopeFormatError(`${bytes.length} bytes is shorter than the header`);
  }

  const version = bytes.readUInt8(VERSION_OFFSET);
  if (version !== ENVELOPE_FORMAT_VERSION) {
    throw new EnvelopeFormatError(
      `format version ${version} is not supported by this build (expected ${ENVELOPE_FORMAT_VERSION})`,
    );
  }

  const keyIdLength = bytes.readUInt8(KEY_ID_LENGTH_OFFSET);
  if (keyIdLength === 0) {
    throw new EnvelopeFormatError('key id is empty');
  }

  const fixedBytes =
    HEADER_BYTES + keyIdLength + IV_BYTES + TAG_BYTES + DATA_KEY_BYTES + IV_BYTES + TAG_BYTES;
  if (bytes.length < fixedBytes) {
    throw new EnvelopeFormatError(
      `${bytes.length} bytes cannot hold a ${fixedBytes}-byte header for a ${keyIdLength}-byte key id`,
    );
  }

  let offset = HEADER_BYTES;
  const take = (length: number): Buffer => {
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };

  const keyId = take(keyIdLength).toString('ascii');
  const wrapIv = take(IV_BYTES);
  const wrapTag = take(TAG_BYTES);
  const wrappedKey = take(DATA_KEY_BYTES);
  const iv = take(IV_BYTES);
  const tag = take(TAG_BYTES);

  return { keyId, wrapIv, wrapTag, wrappedKey, iv, tag, ciphertext: bytes.subarray(offset) };
}

/**
 * The key id an envelope names, without unwrapping anything.
 *
 * What rotation scans with: deciding whether a row needs rewrapping must not
 * require the key that row was written under, or a ring that has already
 * retired a key could not tell you which rows still need it.
 */
export function envelopeKeyId(bytes: Buffer): string {
  return decodeEnvelope(bytes).keyId;
}
