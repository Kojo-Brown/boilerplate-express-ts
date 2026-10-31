# Integration testing against a real Postgres

```bash
pnpm test                # 3,078 tests, no external anything
pnpm test:integration    # 109 tests, one PostgreSQL container
```

`pnpm test` mocks `@/db/query`. That is the right choice for the 200 suites
behind it and it has a blind spot shaped exactly like a database: a mock accepts
any SQL. `src/db/repository.test.ts` asserts that `createMany` composes

```
INSERT INTO "users" ("email", "roles") VALUES ($1, $2), ($3, $4) ON CONFLICT ("email") DO NOTHING RETURNING *
```

and passes whether or not that statement parses, whether `$4` exists, whether
`ON CONFLICT` may legally precede `RETURNING`, and whether `DO NOTHING` with
`RETURNING *` returns the inserted rows or all of them. Thirty-odd methods
across six modules were in that position: fully unit-tested as string builders,
never once executed.

Worse, the modules in `src/db/` are mostly *not* about SQL. They are about
PostgreSQL's concurrency semantics, and their doc-comments say so — "verified
against PostgreSQL 16" appears four times in `advisory-lock.ts` alone. Those
sentences recorded what somebody checked by hand once. Nothing re-checked them,
and every one of them is load-bearing:

- `transaction.ts` claims a deadlock arrives as `40P01` only when
  `deadlock_timeout` is below `lock_timeout`, and as `55P03` otherwise — which
  matters because `RETRYABLE_SQLSTATES` contains the first and deliberately not
  the second, so getting the ordering backwards silently disables the retry loop.
- `locking.ts` claims `FOR NO KEY UPDATE` does not conflict with the `KEY SHARE`
  a foreign-key check takes, and `FOR UPDATE` does. That is the entire basis for
  choosing between the two strengths and it is invisible from the SQL string.
- `advisory-lock.ts` claims the two-`int4` form and the `bigint` form are
  separate lock spaces. If that were wrong, this codebase's locks would collide
  with `node-pg-migrate`'s.
- `versioned-repository.ts` claims the statement's own `version = version + 1`
  cannot double-increment, because a `BEFORE` trigger's assignment wins.

Each of those is now a test. `docs/pessimistic-locking.md`,
`docs/advisory-locks.md` and `docs/optimistic-concurrency.md` explain the
mechanisms; this file is about how the suite runs them.

## Why Testcontainers rather than a service in the workflow

The CI `test` job already attaches a `postgres:16-alpine` service, and for what
it uses it for — proving `pnpm migrate` applies — that is the cheaper mechanism.
It is the wrong one for a test suite, for three reasons that are all about where
the knowledge lives.

A service block is a fact about the workflow. Nothing in the repository would
state that these suites need a server, so `pnpm test:integration` on a
developer's machine either silently talks to whatever is listening on 5432 —
which on a working machine is a development database with data in it — or fails
with a connection error that names no cause. `globalSetup` starting the
container means one command runs the suite the same way everywhere.

A service block also fixes the server *version* in the workflow, far from the
assertions that depend on it. `POSTGRES_IMAGE` in
`src/tests/integration/container.ts` sits next to them.

And a service is shared and long-lived. These suites truncate tables, create and
drop databases, provoke deadlocks and take advisory locks on a namespace they
assume nobody else holds. Against a reused server those are destructive; against
a container that lives for one run they are free.

## Why it is a separate command and not part of `pnpm test`

`pnpm test` is the gate run before every commit, and a pre-push hook can afford
it. Folding a Docker socket into it would mean the common case — a typo in a
parser — stops being checkable on a machine without one, and would add the
container's startup to every run.

This is also not the arrangement `src/redis/redis.integration.test.ts` uses.
That suite lives inside `pnpm test` and skips itself when `REDIS_TEST_URL` is
unset, which needs a second test to stay honest — `redis.guard.test.ts` fails
the build when CI has no server — because a skipped suite is the same colour as
a passing one. Here there is nothing to skip: these files cannot run under the
default config at all (`container.ts` throws a sentence saying so, and
`jest.config.ts` excludes the directory), and the only way to run them is the
command that starts the server. "The suite silently stopped running" is not a
reachable state; the CI job either ran or is missing from the workflow, which is
visible on the pull request.

## Layout

| file | what it is |
| --- | --- |
| `jest.integration.config.ts` | the project: `globalSetup`, `maxWorkers: 1`, a 30s per-test cap |
| `global-setup.ts` | starts the container, runs the migrations once |
| `global-teardown.ts` | stops it |
| `container.ts` | the pinned image, and the env vars that cross from setup to the suites |
| `setup-env.ts` | points `DATABASE_URL` at the container, after `jest.setup.ts` |
| `after-env.ts` | closes the pool each test file opened |
| `fixtures.ts` | fixture tables, `truncate`, and `holding` |

`setup-env.ts` is a `setupFiles` entry *after* `jest.setup.ts` rather than an
edit to it. `jest.setup.ts` points `DATABASE_URL` at a host that does not exist
on purpose: under the default config nothing may reach a real server, so a unit
test that forgot to mock the query layer fails instead of quietly passing
against whatever database the machine has. Relaxing that file to defer to an
existing value would weaken every unit test in the repository, and invisibly — a
developer with `DATABASE_URL` exported would get a different `pnpm test` from
CI's.

## Two things worth knowing before adding a suite

**Do your database work in `beforeAll`/`beforeEach`, not `afterAll`.**
Root-level `afterAll` hooks run in the order they were registered and
`setupFilesAfterEnv` registers before the test file body, so `after-env.ts`
closes the pool *first*. A suite that queries in `afterAll` silently reopens the
pool, and the connection it leaves is terminated by the container shutdown — a
`57P01` logged after the run has already reported green. Fixture tables are
created with `DROP TABLE IF EXISTS` in front, so there is nothing to clean up:
the container is the teardown. (`migrations.integration.test.ts` does use
`afterAll`, to drop the database it created, and can because it holds its own
`Client` rather than the shared pool.)

**Hold locks through `holding`, not a pair of latches.** A holder blocked on a
release latch has a pooled connection checked out, so a failing `expect` between
"it is held" and "let go" abandons that connection; `closePool` then waits for
it and the run reports a 30-second hook timeout instead of the assertion that
failed — the least useful possible output from a test whose job is to be read
when something broke. `holding` releases in a `finally`.

```ts
const result = await holding(
  ({ held, release }) =>
    withTransaction(async (tx) => {
      await items.lockById(tx, 'a');
      held();
      await release;
    }),
  async () => withTransaction(async (tx) => items.lockById(tx, 'a', { wait: 'nowait' })),
);
```

One sharp edge, because `holding` awaits whatever the body resolves to: a body
that starts an operation *blocked on this very lock* must hand it back wrapped —
`return { waiter }` — or the two wait for each other until one times out.

## `maxWorkers: 1`

One server, one database, one file at a time. These suites take row locks on
shared tables, provoke deadlocks, truncate between tests and take advisory locks
on keys they assume nobody else holds — every one a statement about the whole
database rather than about a row, and none of which survives another file doing
the same thing concurrently. A database per worker would buy back a few seconds
on a suite that runs in five, at the cost of a fixture that creates databases
from a template before `setupFiles` can name one. Serial until that is the
bottleneck.

## What is still only covered by a mock

The DB layer is done; the layers above it are not. `src/idempotency/postgres.store.ts`,
`src/outbox/outbox.store.ts` and `src/users/*.repository.ts` all issue SQL of
their own and all are still tested against a mocked query layer, as are the e2e
suites, which drive `createApp()` with the repositories faked. Those are the
next candidates, and they are a larger change than this one: an e2e suite
against a real database needs per-test isolation that `TRUNCATE` between files
does not give it.
