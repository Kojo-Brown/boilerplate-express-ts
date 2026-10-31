import type { QueryResultRow } from 'pg';
import { ANY_VERSION } from '@/concurrency/concurrency.types';
import { query, queryOne } from '@/db/query';
import { VersionedRepository } from '@/db/versioned-repository';
import { withTransaction } from '@/db/transaction';

/**
 * Conditional writes against the `users` table and the trigger that makes them
 * mean anything.
 *
 * This is one of the two suites that use the application's own schema rather
 * than a fixture table, and the reason is that the behaviour under test is half
 * in the migration. `VersionedRepository` composes a `WITH updated AS (...)`
 * statement whose correctness depends on claims no mock can check:
 *
 * - `users_bump_version` moves the version on **every** update, including one
 *   issued by the inherited unconditional `BaseRepository.update`. That is what
 *   `versioned-repository.ts` means by "the guarantee does not depend on every
 *   writer going through this class", and if it were false an `ETag` handed out
 *   before a background job's write would still compare equal afterwards.
 * - The `SET "version" = "version" + 1` the statement also carries does **not**
 *   double-increment, because a `BEFORE` trigger's assignment to `NEW.version`
 *   wins. The doc-comment says it "costs nothing"; a version that moved by two
 *   would invalidate an `If-Match` the client was entitled to retry with.
 * - The CTE really does evaluate once, so `NOT EXISTS (SELECT 1 FROM updated)`
 *   distinguishes "no such row" from "wrong version" inside a single snapshot —
 *   the whole point of not doing update-then-look.
 *
 * `users` rows are created and removed by the suite; `password_hash` is left
 * null, which the column permits, and the emails are obviously-fake addresses
 * under the reserved `.test` TLD.
 */

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  roles: string[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

type UserInsert = { email: string; roles?: string[] };
type UserUpdate = { email?: string; roles?: string[]; version?: number };

class Users extends VersionedRepository<UserRow, UserInsert, UserUpdate> {
  protected override readonly tableName = 'users';
}

const users = new Users();

beforeEach(async () => {
  await query('TRUNCATE TABLE "users" CASCADE');
});

async function makeUser(email = 'subject@example.test'): Promise<UserRow> {
  return users.create({ email });
}

describe('the version column and its trigger', () => {
  it('starts at 1, so "no version" and "the first version" are never the same value', async () => {
    expect((await makeUser()).version).toBe(1);
  });

  it('moves on an unconditional update, which is what makes an ETag honest', async () => {
    const user = await makeUser();

    const updated = await users.update(user.id, { email: 'renamed@example.test' });

    // Through `BaseRepository.update`, which never mentions `version`. The
    // trigger is the writer.
    expect(updated?.version).toBe(2);
  });

  it('moves on a write that bypasses the repository entirely', async () => {
    const user = await makeUser();

    await query('UPDATE "users" SET email = $1 WHERE id = $2', ['psql@example.test', user.id]);

    expect((await users.findById(user.id))?.version).toBe(2);
  });

  it('moves by exactly one when the statement also sets it, not by two', async () => {
    const user = await makeUser();

    const result = await users.updateWithVersion(
      user.id,
      { email: 'cas@example.test' },
      { kind: 'versions', versions: [1] },
    );

    expect(result).toMatchObject({ outcome: 'updated' });
    // The `BEFORE` trigger's assignment wins over the statement's `version + 1`.
    // Two would have broken the client's next `If-Match`.
    expect(result.outcome === 'updated' && result.row.version).toBe(2);
  });

  it('refuses a patch that tries to forge the version', async () => {
    const user = await makeUser();

    await users.update(user.id, { version: 99, email: 'forged@example.test' });

    expect((await users.findById(user.id))?.version).toBe(2);
  });
});

describe('updateWithVersion', () => {
  it('updates when the current version is in the named set', async () => {
    const user = await makeUser();

    const result = await users.updateWithVersion(
      user.id,
      { roles: ['admin'] },
      { kind: 'versions', versions: [7, 1, 9] },
    );

    expect(result.outcome).toBe('updated');
    expect(result.outcome === 'updated' && result.row.roles).toEqual(['admin']);
    // `= ANY(...)`, which is what an `If-Match` list of entity-tags means: any
    // one of them matching is a match.
    expect(result.outcome === 'updated' && result.row.version).toBe(2);
  });

  it('reports the current version on a conflict, in one statement', async () => {
    const user = await makeUser();
    await users.update(user.id, { email: 'moved@example.test' });

    const result = await users.updateWithVersion(
      user.id,
      { roles: ['admin'] },
      { kind: 'versions', versions: [1] },
    );

    expect(result).toEqual({ outcome: 'conflict', currentVersion: 2 });
    // Nothing was written. The `UPDATE` branch of the CTE matched no row, and
    // the `SELECT` branch reads the pre-update snapshot.
    expect((await users.findById(user.id))?.roles).toEqual(['user']);
    expect((await users.findById(user.id))?.version).toBe(2);
  });

  it('reports missing rather than conflict for a row that is not there', async () => {
    const result = await users.updateWithVersion(
      '00000000-0000-0000-0000-000000000000',
      { roles: ['admin'] },
      { kind: 'versions', versions: [1] },
    );

    // The distinction a follow-up `SELECT` would race on: 404 against 412.
    expect(result).toEqual({ outcome: 'missing' });
  });

  it('matches no row for an empty version list', async () => {
    const user = await makeUser();

    expect(await users.updateWithVersion(user.id, { roles: ['admin'] }, { kind: 'versions', versions: [] })).toEqual(
      { outcome: 'conflict', currentVersion: 1 },
    );
  });

  it('requires only existence under If-Match: *', async () => {
    const user = await makeUser();
    await users.update(user.id, { email: 'whatever@example.test' });

    const result = await users.updateWithVersion(user.id, { roles: ['admin'] }, ANY_VERSION);

    expect(result.outcome).toBe('updated');
    expect(result.outcome === 'updated' && result.row.version).toBe(3);
  });

  it('sends an empty patch to the server anyway, because it is a version assertion', async () => {
    const user = await makeUser();

    // No writable column in the patch. `BaseRepository.update` would short-cut
    // to `findById` and answer 200; here the precondition has to reach the
    // database, so a stale one is a conflict.
    expect(await users.updateWithVersion(user.id, {}, { kind: 'versions', versions: [5] })).toEqual({
      outcome: 'conflict',
      currentVersion: 1,
    });

    const matched = await users.updateWithVersion(user.id, {}, { kind: 'versions', versions: [1] });
    expect(matched.outcome).toBe('updated');
    expect(matched.outcome === 'updated' && matched.row.version).toBe(2);
  });

  it('returns a row with no __updated flag on it', async () => {
    const user = await makeUser();

    const result = await users.updateWithVersion(user.id, { roles: ['admin'] }, ANY_VERSION);

    expect(result.outcome).toBe('updated');
    const row = result.outcome === 'updated' ? result.row : null;
    expect(row).not.toBeNull();
    expect(Object.keys(row as object)).not.toContain('__updated');
    // And `created_at` survived as a `Date` rather than being flattened to a
    // string, which is what `to_jsonb(row)` would have done and why the flag is
    // a real column.
    expect(row?.created_at).toBeInstanceOf(Date);
  });

  it('serialises two conditional writes so exactly one of them wins', async () => {
    const user = await makeUser();

    const [first, second] = await Promise.all([
      users.updateWithVersion(user.id, { email: 'first@example.test' }, { kind: 'versions', versions: [1] }),
      users.updateWithVersion(user.id, { email: 'second@example.test' }, { kind: 'versions', versions: [1] }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    // Compare-and-swap doing its job on a real server: the loser sees the
    // version the winner produced, under `read committed`, because the second
    // statement re-evaluated its predicate against the committed row.
    expect(outcomes).toEqual(['conflict', 'updated']);
    expect((await users.findById(user.id))?.version).toBe(2);
  });
});

describe('deleteWithVersion', () => {
  it('deletes when the version matches', async () => {
    const user = await makeUser();

    expect(await users.deleteWithVersion(user.id, { kind: 'versions', versions: [1] })).toEqual({
      outcome: 'deleted',
    });
    expect(await users.findById(user.id)).toBeNull();
  });

  it('reports the current version on a conflict and leaves the row alone', async () => {
    const user = await makeUser();
    await users.update(user.id, { email: 'moved@example.test' });

    expect(await users.deleteWithVersion(user.id, { kind: 'versions', versions: [1] })).toEqual({
      outcome: 'conflict',
      currentVersion: 2,
    });
    expect(await users.findById(user.id)).not.toBeNull();
  });

  it('reports missing for a row that is not there', async () => {
    expect(
      await users.deleteWithVersion('00000000-0000-0000-0000-000000000000', ANY_VERSION),
    ).toEqual({ outcome: 'missing' });
  });

  it('deletes under If-Match: * whatever the version is', async () => {
    const user = await makeUser();
    await users.update(user.id, { email: 'moved@example.test' });

    expect(await users.deleteWithVersion(user.id, ANY_VERSION)).toEqual({ outcome: 'deleted' });
  });
});

describe('inside a caller’s transaction', () => {
  it('rolls a conditional write back with it', async () => {
    const user = await makeUser();

    await expect(
      withTransaction(async (tx) => {
        const result = await users.updateWithVersion(
          user.id,
          { email: 'in-tx@example.test' },
          { kind: 'versions', versions: [1] },
          tx,
        );
        expect(result.outcome).toBe('updated');
        throw new Error('abandon');
      }),
    ).rejects.toThrow('abandon');

    const after = await queryOne<{ email: string; version: number }>(
      'SELECT email, version FROM "users" WHERE id = $1',
      [user.id],
    );
    expect(after).toEqual({ email: 'subject@example.test', version: 1 });
  });
});
