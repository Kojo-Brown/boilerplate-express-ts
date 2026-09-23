# Field-level encryption at rest

Disk encryption protects a stolen disk. It does nothing about the cases that
actually happen: a backup copied to the wrong bucket, a read replica an
analytics team was given, a `SELECT *` in a support tool, a dump attached to a
ticket. In all of those the database is running, the volume is mounted, and
every byte in it is readable.

Field-level encryption moves the boundary. The value is ciphertext from the
moment it leaves the application until the moment it comes back, so anything
that reads the table — a dump, a replica, a query — gets bytes that need a key
the database does not have.

Implemented in `src/crypto/`, applied to `user_pii` by
`src/users/user-pii.repository.ts`.

## Two keys, not one

Each value is encrypted under a **data key** generated for that value alone.
That data key is then encrypted ("wrapped") under a **key-encryption key** from
the ring, and stored beside the ciphertext. That is the envelope.

A single column-wide key would be simpler and worse, in three ways:

- **Blast radius.** One recovered key opens the column. Here it opens one
  field.
- **Nonce budget.** AES-GCM with random 96-bit nonces is safe for roughly 2³²
  messages *under one key* before collision probability stops being negligible.
  A user table can reach that. A key used exactly once has no budget to spend.
- **Rotation cost.** Rotating a column-wide key means decrypting and
  re-encrypting every value. Rotating a key-encryption key means rewriting 32
  bytes per row — the wrapped data key — and never touching the payload. That
  is `FieldCipher.rewrap`, and it is the entire reason this is worth the extra
  layer.

## Every ciphertext is bound to its row

GCM authenticates *additional data* alongside the payload. Here that data is
the value's address: table, column, row id.

```ts
cipher.encrypt(phone, { table: 'user_pii', column: 'phone_encrypted', id: userId });
```

Without it, anybody who can write to the database can copy one user's encrypted
phone number into another user's row, and the application will decrypt it and
serve it as that user's own — the bytes are authentic and intact, they are
simply in the wrong place. With it, that row does not decrypt at all.

This is why `user_pii` is keyed by the user's id rather than by a generated one:
the binding has to be known *before* the insert, and a `gen_random_uuid()`
default is known after it.

The header — format version and key id — is authenticated too, so relabelling a
row to name a different key breaks the tag rather than selecting that key.

## What this deliberately does not give you

**Searchability.** A fresh key and nonce per value mean two equal plaintexts
encrypt to unrelated bytes. `WHERE phone_encrypted = $1` cannot work, and an
index on the column serves nothing. That is the property that makes the scheme
safe rather than a gap in it: deterministic encryption, which would make the
lookup work, tells anyone holding a backup which rows share a value.

A field you must look up by value needs a **blind index**: a separate column
holding a keyed HMAC of a normalised form of the value, indexed and queried
directly. It leaks equality by design — that is what makes it searchable — so
it is a decision to take per field, not a default to inherit. Nothing here
stops you adding one; it is deliberately not added for you.

**Protection from a compromised application.** The running service holds the
keys, by construction: it has to, to serve the data. This defends against
everything that reads the *storage* — dumps, replicas, backups, stray queries —
and against anyone who can write to the database but not run code in the
service. It does not defend against code execution in the service itself.

**Key custody.** `FIELD_ENCRYPTION_KEYS` holds raw key material. For a
deployment that needs keys never to be in the process's environment, the shape
here is already the right one: the ring is the only thing that touches a
key-encryption key, so replacing `parseKeyring` with a KMS client that wraps and
unwraps data keys remotely is a change to one module. The envelope, the
binding, and the rotation procedure are unaffected.

## The stored format

`bytea`, self-describing, version-first:

```
1 byte   format version (1)
1 byte   key id length n
n bytes  key id, ASCII
12 bytes nonce for the wrapped data key
16 bytes GCM tag over the wrapped data key
32 bytes the data key, encrypted under the key-encryption key
12 bytes nonce for the payload
16 bytes GCM tag over the payload
rest     the value, encrypted under the data key
```

A row carries the id of the key that opens it because the alternative is a
deployment in which "which key is this?" is answered by configuration. That
makes restoring last month's backup into this month's fleet unreadable, and
makes any key change a synchronised rewrite of every table.

The version byte is what lets the format change. A value in a format this build
does not know is an error and never a guess: another version may put different
things at these offsets, and guessing produces a plausible plaintext from the
wrong bytes.

## Rotating a key-encryption key

Three deployments, in this order. Skipping the middle one is an outage.

1. **Add the new key to the ring, everywhere.**
   `FIELD_ENCRYPTION_KEYS=old:…,new:…` with `FIELD_ENCRYPTION_ACTIVE_KEY_ID`
   still `old`. Nothing changes behaviourally; the key is merely *available*.
   This step has to reach every instance before the next one starts.

2. **Make it active.** `FIELD_ENCRYPTION_ACTIVE_KEY_ID=new`. New writes are
   wrapped under `new`; everything already stored still names `old` and still
   reads, because the ring holds both.

3. **Rewrap, then retire.**

   ```
   pnpm rotate:field-keys [batchSize] [maxPages]
   ```

   Walks `user_pii` by keyset cursor, re-wrapping every data key that still
   names a retired key. Safe to interrupt, safe to re-run, safe to run against
   a live service: each row is one statement, and both keys are in the ring
   throughout. `maxPages` bounds a pass so it can be run in windows; the cursor
   to resume from is printed. Only once a pass completes can `old` be removed
   from the ring.

Doing (2) before (1) has reached every instance means the instances that have
not rolled yet cannot read what the rolled ones just wrote. Doing (3)'s removal
early means every row still naming the old key becomes an error — intact data
that nothing can open. This is why the configuration is a ring and not a key:
the list *is* the mechanism for the middle of a rotation.

The rotation scan reads every row, because the key id lives inside the envelope
and `WHERE` cannot select the stale ones. That is the right trade at boilerplate
scale and the wrong one at a few million rows: add a `key_id` column written
alongside each envelope, index it, and filter the scan on it. Nothing about the
format changes — the column is a denormalised copy of a header field.

## Configuration

| Variable | Meaning |
| --- | --- |
| `FIELD_ENCRYPTION_KEYS` | `id:base64,…`, 32 raw bytes per key (`openssl rand -base64 32`) |
| `FIELD_ENCRYPTION_ACTIVE_KEY_ID` | Which of them wraps new writes |

Both are required, with no defaults. There is no "encryption disabled" mode,
because that mode's failure is silent: a boot that quietly skips encryption
produces a table of plaintext PII that everyone believes is encrypted, and
nothing reports it until somebody reads the table. A deployment that stores no
encrypted fields still needs a key, which costs one `openssl` invocation.

The ring is parsed at boot, in `@/config/env`, so a malformed entry, a key that
is not 32 bytes, a duplicate id or an active id the ring does not hold all stop
the process before it takes traffic. Key-ring and decryption errors never
include key material or plaintext in their messages: an error string is the one
place secrets reliably escape a process.

## Erasure

`user_pii` is its own table, so deleting a user's personal data is one `DELETE`
of one row, and `ON DELETE CASCADE` means deleting the user is not a way to
leave it behind. On a wide `users` row it would be an `UPDATE`, leaving the old
ciphertext in a dead tuple until vacuum reaches it, in index pages, and in every
WAL segment already shipped to a replica.

Discarding the key is not erasure of one user's data — the key is shared by the
whole column. Per-user key discard ("crypto-shredding") needs a data key per
user rather than per value, which is a different trade: it makes erasure
instant and makes one recovered key open everything that user has.
