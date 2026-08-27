import {
  USER_IMPORT_BATCH_SIZE,
  USER_IMPORT_COLUMNS,
  userImportRowSchema,
  writeUserImportBatch,
} from '@/users/users-import';
import { MAX_BIND_PARAMETERS } from '@/db/repository';
import type { UserInsert, UserRepository } from '@/users/users.repository';

interface CreateManyCall {
  readonly rows: readonly UserInsert[];
  readonly options: unknown;
}

/**
 * Only the one method this unit needs. Typed through `UserRepository` so a
 * change to `createMany`'s signature breaks this file rather than being
 * absorbed by a `jest.Mock<any>`.
 */
function fakeRepository(insertedPerCall: number[] = []): {
  repository: UserRepository;
  calls: CreateManyCall[];
} {
  const calls: CreateManyCall[] = [];
  let callIndex = 0;

  const createMany: UserRepository['createMany'] = (rows, options = {}) => {
    calls.push({ rows: [...rows], options });
    const inserted = insertedPerCall[callIndex] ?? rows.length;
    callIndex += 1;
    return Promise.resolve(
      Array.from({ length: inserted }, (_, i) => ({
        id: `id-${String(i)}`,
        email: `row-${String(i)}@x.test`,
        password_hash: null,
        roles: ['user'],
        created_at: new Date(0),
        updated_at: new Date(0),
        version: 1,
      })),
    );
  };

  return { repository: { createMany } as unknown as UserRepository, calls };
}

describe('userImportRowSchema', () => {
  it('lower-cases the address so a file cannot create two accounts for one person', () => {
    expect(userImportRowSchema.parse({ email: 'Alice@X.Test' })).toEqual({
      email: 'alice@x.test',
      roles: undefined,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(userImportRowSchema.parse({ email: '  a@x.test  ' }).email).toBe('a@x.test');
  });

  it('splits a quoted, comma-separated roles field', () => {
    expect(userImportRowSchema.parse({ email: 'a@x.test', roles: 'admin,auditor' }).roles).toEqual([
      'admin',
      'auditor',
    ]);
  });

  it('tolerates spacing inside the roles list', () => {
    expect(userImportRowSchema.parse({ email: 'a@x.test', roles: ' admin , auditor ' }).roles).toEqual(
      ['admin', 'auditor'],
    );
  });

  it('treats a blank roles cell as "not stated" rather than as an empty list', () => {
    // `[]` would override the column's `ARRAY['user']` default and create a
    // user who can do nothing.
    expect(userImportRowSchema.parse({ email: 'a@x.test', roles: '' }).roles).toBeUndefined();
    expect(userImportRowSchema.parse({ email: 'a@x.test', roles: ' , , ' }).roles).toBeUndefined();
  });

  it.each(['', '   ', 'not-an-email', 'a@', '@x.test'])('rejects %p as an address', (email) => {
    expect(userImportRowSchema.safeParse({ email }).success).toBe(false);
  });

  it('ignores a column the header did not bind', () => {
    const parsed = userImportRowSchema.parse({ email: 'a@x.test', password_hash: 'anything' });
    expect(parsed).not.toHaveProperty('password_hash');
  });
});

describe('USER_IMPORT_COLUMNS', () => {
  it('does not accept a credential column', () => {
    // A bulk endpoint that can set a password hash directly is a bulk endpoint
    // that can mint accounts whose pre-image the caller knows.
    expect(USER_IMPORT_COLUMNS.map((column) => column.name)).toEqual(['email', 'roles']);
  });

  it('keeps the batch inside the protocol’s bind-parameter ceiling', () => {
    expect(USER_IMPORT_BATCH_SIZE * USER_IMPORT_COLUMNS.length).toBeLessThanOrEqual(
      MAX_BIND_PARAMETERS,
    );
  });
});

describe('writeUserImportBatch', () => {
  it('inserts the batch with ON CONFLICT (email) DO NOTHING', async () => {
    const { repository, calls } = fakeRepository();
    await writeUserImportBatch(repository, [
      { email: 'a@x.test', roles: ['user'] },
      { email: 'b@x.test', roles: ['user'] },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ onConflict: 'ignore', conflictTarget: ['email'] });
  });

  it('returns how many rows were actually written, not how many were offered', async () => {
    const { repository } = fakeRepository([1]);
    const written = await writeUserImportBatch(repository, [
      { email: 'a@x.test', roles: undefined },
      { email: 'b@x.test', roles: undefined },
    ]);
    expect(written).toBe(1);
  });

  it('de-duplicates within the batch so a repeat does not spend a bind slot', async () => {
    // Not for correctness: `ON CONFLICT DO NOTHING` handles an in-statement
    // repeat on its own (verified against PostgreSQL 16.13). This keeps a file
    // listing one address 500 times from spending 500 of the statement's
    // bind-parameter budget to insert one row.
    const { repository, calls } = fakeRepository();
    await writeUserImportBatch(repository, [
      { email: 'a@x.test', roles: undefined },
      { email: 'a@x.test', roles: undefined },
      { email: 'b@x.test', roles: undefined },
    ]);

    expect(calls[0]?.rows.map((row) => row.email)).toEqual(['a@x.test', 'b@x.test']);
  });

  it('omits the roles key entirely when the row did not state one', async () => {
    // `roles: undefined` would be a column in the statement's list bound to
    // NULL, which defeats the table's default and fails its NOT NULL.
    const { repository, calls } = fakeRepository();
    await writeUserImportBatch(repository, [{ email: 'a@x.test', roles: undefined }]);

    expect(calls[0]?.rows[0]).toEqual({ email: 'a@x.test' });
    expect(Object.keys(calls[0]?.rows[0] ?? {})).not.toContain('roles');
  });

  it('groups rows by shape so one statement never mixes column lists', async () => {
    const { repository, calls } = fakeRepository();
    const written = await writeUserImportBatch(repository, [
      { email: 'a@x.test', roles: ['admin'] },
      { email: 'b@x.test', roles: undefined },
      { email: 'c@x.test', roles: ['user'] },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.rows.length).sort()).toEqual([1, 2]);
    expect(written).toBe(3);
  });

  it('does nothing for an empty batch', async () => {
    const { repository, calls } = fakeRepository();
    await expect(writeUserImportBatch(repository, [])).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });
});
