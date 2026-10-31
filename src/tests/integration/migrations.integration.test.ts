import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { DEFAULT_MIGRATIONS_DIR, MIGRATIONS_TABLE, runMigrations } from '@/db/migrate';
import { integrationAdminUrl, urlForDatabase } from './container';

/**
 * `runMigrations` against a database that starts empty.
 *
 * The unit suite mocks `node-pg-migrate`'s `runner` and asserts the options
 * handed to it, which settles the wrapper's argument handling and nothing about
 * the migrations themselves. Two things only a real server can say:
 *
 * **That the migrations apply at all.** Until this file existed, the evidence
 * was the CI `test` job's `pnpm migrate` step against the workflow's Postgres
 * service — real, but a single `up` against a database the next job throws
 * away, with no assertion about what it produced.
 *
 * **That every `down` is honest.** This is the one that cannot be checked any
 * other way and is the reason the suite exists. A `down` is written once, runs
 * approximately never, and is the thing an operator reaches for at the worst
 * possible moment. The test below migrates the whole stack down to nothing and
 * back up, and compares a full schema snapshot across the round trip — so a
 * `down` that drops a table but leaves its trigger function, or forgets a
 * column it added, fails here rather than during a rollback.
 *
 * It runs against a database of its own, created and dropped by the suite. The
 * shared one that every other suite uses is migrated once in `globalSetup`, and
 * a suite that dismantles a schema cannot be allowed anywhere near it.
 */

const DATABASE = `it_migrations_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const databaseUrl = urlForDatabase(DATABASE);

/** Every migration file, in the order `node-pg-migrate` applies them. */
const migrationNames = readdirSync(DEFAULT_MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => path.basename(name, '.ts'))
  .sort();

let admin: Client;
let db: Client;

/**
 * `node-pg-migrate` logs a banner per migration per direction through
 * `console.info`, and this suite runs the stack up and down six times. Silenced
 * so that a failure here is readable; `console.error` is left alone.
 */
let migrationLog: jest.SpyInstance;

/**
 * Everything about the schema that a `down` could plausibly fail to undo:
 * tables and their columns with types and nullability, defaults, constraints,
 * indexes, triggers, and the functions a trigger calls.
 *
 * `pgmigrations` is excluded because it is the ledger rather than the schema —
 * it is created by the first `up` and, by design, is not dropped by the last
 * `down`.
 *
 * Objects owned by an extension are excluded too, which is not a loophole but
 * the only way to compare the migrations' own schema: `pgcrypto` installs about
 * 145 functions into `public`, and the initial migration's `down` deliberately
 * does not drop the extension — an extension is a database-wide facility that
 * something else may also be using, and `createExtension` is written
 * `ifNotExists` for the same reason. That it survives the round trip is
 * asserted separately below rather than left implicit.
 */
const SCHEMA_SNAPSHOT_SQL = `
  SELECT jsonb_build_object(
    'columns', (
      SELECT COALESCE(jsonb_agg(c ORDER BY c->>'t', c->>'n'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          't', table_name, 'n', column_name, 'type', data_type,
          'nullable', is_nullable, 'default', column_default
        ) AS c
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> '${MIGRATIONS_TABLE}'
      ) s
    ),
    'constraints', (
      SELECT COALESCE(jsonb_agg(c ORDER BY c->>'n'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('n', conname, 'def', pg_get_constraintdef(oid)) AS c
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conrelid::regclass::text <> '${MIGRATIONS_TABLE}'
      ) s
    ),
    'indexes', (
      SELECT COALESCE(jsonb_agg(i ORDER BY i->>'n'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('n', indexname, 'def', indexdef) AS i
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> '${MIGRATIONS_TABLE}'
      ) s
    ),
    'triggers', (
      SELECT COALESCE(jsonb_agg(t ORDER BY t->>'n'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'n', trigger_name, 't', event_object_table,
          'when', action_timing, 'op', event_manipulation, 'what', action_statement
        ) AS t
        FROM information_schema.triggers WHERE trigger_schema = 'public'
      ) s
    ),
    'functions', (
      SELECT COALESCE(jsonb_agg(f ORDER BY f->>'n'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('n', proname, 'src', prosrc) AS f
        FROM pg_proc p
        WHERE pronamespace = 'public'::regnamespace
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
          )
      ) s
    )
  ) AS snapshot
`;

async function schemaSnapshot(): Promise<unknown> {
  const result = await db.query<{ snapshot: unknown }>(SCHEMA_SNAPSHOT_SQL);
  return result.rows[0]?.snapshot;
}

async function tableNames(): Promise<string[]> {
  const result = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return result.rows.map((row) => row.table_name);
}

async function extensions(): Promise<string[]> {
  const result = await db.query<{ extname: string }>('SELECT extname FROM pg_extension');
  return result.rows.map((row) => row.extname);
}

async function ledger(): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY id`,
  );
  return result.rows.map((row) => row.name);
}

beforeAll(async () => {
  migrationLog = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  admin = new Client({ connectionString: integrationAdminUrl() });
  await admin.connect();
  // Not parameterised, because `CREATE DATABASE` takes no bind parameters. The
  // name is a UUID with the dashes removed, built in this file.
  await admin.query(`CREATE DATABASE "${DATABASE}"`);

  db = new Client({ connectionString: databaseUrl });
  await db.connect();
});

afterAll(async () => {
  migrationLog.mockRestore();
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  await admin.end();
});

describe('up', () => {
  it('finds the migrations it is going to apply', () => {
    // A guard on the suite rather than on the code: every assertion below is
    // about a round trip over this list, and an empty one would make all of
    // them pass while measuring nothing.
    expect(migrationNames.length).toBeGreaterThan(0);
  });

  it('applies every migration and records each one in the ledger', async () => {
    await runMigrations({ databaseUrl });

    expect(await ledger()).toEqual(migrationNames);
    expect(await tableNames()).toEqual(
      expect.arrayContaining([MIGRATIONS_TABLE, 'users', 'refresh_tokens']),
    );
  });

  it('produces the schema the application expects', async () => {
    const users = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY column_name",
    );

    // Spot-checked rather than snapshotted: these are the columns the DB layer
    // names in SQL it writes by hand, so their absence is a runtime failure on
    // a route rather than a type error.
    expect(users.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['id', 'email', 'password_hash', 'roles', 'version', 'created_at', 'updated_at']),
    );

    // The trigger `VersionedRepository`'s whole guarantee rests on.
    const triggers = await db.query<{ trigger_name: string }>(
      "SELECT DISTINCT trigger_name FROM information_schema.triggers WHERE event_object_table = 'users'",
    );
    expect(triggers.rows.map((row) => row.trigger_name)).toContain('users_bump_version');
  });

  it('is a no-op when everything is already applied', async () => {
    const before = await ledger();

    await runMigrations({ databaseUrl });

    expect(await ledger()).toEqual(before);
  });
});

describe('down', () => {
  it('reverses one migration at a time, newest first', async () => {
    const before = await ledger();
    const last = before[before.length - 1];

    await runMigrations({ databaseUrl, direction: 'down', count: 1 });

    expect(await ledger()).toEqual(before.slice(0, -1));
    expect(last).toBeDefined();

    await runMigrations({ databaseUrl });
    expect(await ledger()).toEqual(before);
  });

  it('round-trips the whole stack: down to nothing, up again, same schema', async () => {
    const applied = await schemaSnapshot();

    await runMigrations({ databaseUrl, direction: 'down', count: migrationNames.length });

    expect(await ledger()).toEqual([]);
    // Nothing of the schema is left — not a table, not the trigger function,
    // not an index. The ledger table itself stays, which is `node-pg-migrate`'s
    // behaviour and not something a migration controls.
    expect(await tableNames()).toEqual([MIGRATIONS_TABLE]);
    expect(await schemaSnapshot()).toEqual({
      columns: [],
      constraints: [],
      indexes: [],
      triggers: [],
      functions: [],
    });
    // Left behind on purpose: the initial migration creates `pgcrypto`
    // `ifNotExists` and its `down` does not drop it, because an extension is a
    // database-wide facility that other schemas may depend on. `gen_random_uuid`
    // is therefore still callable here, with no table left to default from.
    expect(await extensions()).toContain('pgcrypto');

    await runMigrations({ databaseUrl });

    // The assertion the suite exists for. A `down` that forgets a column, an
    // index, a constraint or a trigger function fails here, now, rather than
    // during the rollback somebody reaches for at 3am.
    expect(await schemaSnapshot()).toEqual(applied);
    expect(await ledger()).toEqual(migrationNames);
    expect(await extensions()).toContain('pgcrypto');
  });
});

describe('the wrapper’s defaults', () => {
  it('migrates the configured database when no url is given', async () => {
    // `DATABASE_URL` is the shared database `globalSetup` already migrated, so
    // this is a no-op there by construction — which is the point: it exercises
    // the default without a second database to tidy up, and a default pointing
    // somewhere unexpected would fail loudly instead.
    await expect(runMigrations()).resolves.toBeUndefined();
  });

  it('defaults the migrations directory to the repository’s own', () => {
    expect(DEFAULT_MIGRATIONS_DIR).toBe(path.join(process.cwd(), 'migrations'));
  });
});
