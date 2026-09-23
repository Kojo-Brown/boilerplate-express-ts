/**
 * The set of key-encryption keys (KEKs) this process can unwrap data keys with,
 * and which one of them new writes are wrapped under.
 *
 * A ring rather than a key, because rotation is a two-phase deployment and a
 * single `FIELD_ENCRYPTION_KEY` cannot express the middle phase. Replacing one
 * key with another in one step means that between the first instance restarting
 * and the last, half the fleet cannot read what the other half just wrote —
 * every read of an older row is a decryption failure, and those are 500s on
 * data that is perfectly intact. So: add the new key to every instance's ring
 * first (nothing changes; it is simply *available*), then, once the whole fleet
 * has it, flip `FIELD_ENCRYPTION_ACTIVE_KEY_ID`. Retiring the old key is a
 * third deployment, after `rotate-field-keys` has rewrapped everything that
 * still names it.
 *
 * Nothing here reads `env` — `@/config/env` validates the key material at boot
 * by calling `parseKeyring`, so this module is the leaf of that relationship
 * and importing configuration would make it a cycle.
 */

const KEY_BYTES = 32;

/**
 * The charset a key id may use, and a length the envelope header can hold.
 *
 * The id is written into every ciphertext (that is how a row remembers which
 * key opens it), so it is a persisted identifier and not a label to be edited:
 * keep it short and boring, `2026-09` or `k3`. The restriction to printable
 * ASCII is what lets the header store it as bytes with a one-byte length rather
 * than carrying an encoding.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

/** A parsed key-ring entry: an id somebody chose and 32 bytes of key. */
export interface KeyringEntry {
  readonly id: string;
  readonly key: Buffer;
}

export interface Keyring {
  /** The id new envelopes are wrapped under. */
  readonly activeKeyId: string;
  /** The key new envelopes are wrapped under. */
  active(): KeyringEntry;
  /** The key that opens an existing envelope, or `undefined` if it is not held. */
  find(keyId: string): KeyringEntry | undefined;
  /** Every id held, in the order the spec listed them. Ids only — never key bytes. */
  ids(): readonly string[];
}

/**
 * Thrown for a key ring that cannot be used: a malformed entry, a key that is
 * not 32 bytes, an active id naming a key the ring does not hold.
 *
 * Deliberately not an `AppError`. A key-ring problem is a configuration fault
 * that must stop the boot, not a request that failed with a status code, and
 * giving it one would make it tempting to catch somewhere and carry on with
 * encryption quietly broken.
 *
 * The messages below name the offending *entry* and never its value. An error
 * string is the one place key material reliably escapes a process — it goes to
 * stdout, to the log shipper, and into whatever aggregates errors by message —
 * and a config error is exactly when somebody is pasting keys around.
 */
export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
    Error.captureStackTrace(this, this.constructor);
  }
}

function parseEntry(raw: string, position: number): KeyringEntry {
  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new KeyringError(
      `entry ${position} is not in "<key-id>:<base64-key>" form ` +
        '(no ":" separating an id from its key)',
    );
  }

  const id = raw.slice(0, separator);
  if (!KEY_ID_PATTERN.test(id)) {
    throw new KeyringError(
      `entry ${position} has key id "${id}", which is not 1-32 characters of [A-Za-z0-9_.-]`,
    );
  }

  const encoded = raw.slice(separator + 1);
  // `Buffer.from(s, 'base64')` does not fail on rubbish — it decodes what it
  // can and stops, so "not base64 at all" arrives here as a short buffer and
  // would otherwise be reported as a length problem. Re-encoding and comparing
  // is the check Node does not give us; the length assertion below then means
  // what it says.
  const key = Buffer.from(encoded, 'base64');
  if (key.toString('base64') !== encoded) {
    throw new KeyringError(`entry ${position} ("${id}") is not valid base64`);
  }
  if (key.length !== KEY_BYTES) {
    throw new KeyringError(
      `entry ${position} ("${id}") decodes to ${key.length} bytes; ` +
        `AES-256-GCM needs exactly ${KEY_BYTES}`,
    );
  }

  return { id, key };
}

/**
 * Parse `FIELD_ENCRYPTION_KEYS` — `id:base64,id:base64,…` — and pick the active
 * key out of it.
 *
 * Pure, and exported for `@/config/env` to run at boot. A key ring that is
 * going to be rejected should be rejected by the process that has not started
 * serving yet, not by the first request that happens to touch an encrypted
 * column: the failure is identical in both places and only one of them is
 * cheap to notice.
 */
export function parseKeyring(spec: string, activeKeyId: string): Keyring {
  const entries = spec
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseEntry);

  if (entries.length === 0) {
    throw new KeyringError('holds no keys');
  }

  const byId = new Map<string, KeyringEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new KeyringError(
        `has two keys with id "${entry.id}"; ids are what a stored ciphertext ` +
          'names, so they have to be unique',
      );
    }
    byId.set(entry.id, entry);
  }

  const active = byId.get(activeKeyId);
  if (!active) {
    throw new KeyringError(
      `names "${activeKeyId}" as the active key, which the ring does not hold ` +
        `(it holds: ${entries.map((entry) => entry.id).join(', ')})`,
    );
  }

  const ids = Object.freeze(entries.map((entry) => entry.id));

  return {
    activeKeyId,
    active: () => active,
    find: (keyId: string) => byId.get(keyId),
    ids: () => ids,
  };
}
