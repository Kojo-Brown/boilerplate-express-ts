/**
 * The measuring half: `pnpm test:load`.
 *
 * Seeds the users the profile reads, mints the run's access token, starts the
 * server, drives k6 against it for a minute, stops the server, and leaves a
 * summary and a server log in `reports/load/`. It decides nothing — the
 * ceilings are read by `pnpm check:load`.
 *
 * It needs a Postgres on `DATABASE_URL` and the secrets the config module
 * validates at boot, which is the same environment `pnpm test` and
 * `pnpm migrate` want. See `docs/load-testing.md`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closePool, getPool } from '@/db/pool';
import { signAccessToken } from '@/lib/jwt';
import { ADMIN_ROLE } from '@/users/users.repository';
import {
  LOAD_REPORT_DIR,
  LOAD_SERVER_LOG_FILENAME,
  LOAD_SUMMARY_FILENAME,
  LOAD_USER_POOL_SIZE,
} from './budgets';

/**
 * Everything this script touches is anchored here rather than at
 * `process.cwd()`: `pnpm test:load` runs from the package root, but a run
 * started from a subdirectory would otherwise mount the wrong directories into
 * the k6 container and write the summary somewhere the gate does not look.
 */
const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * The port the run's server listens on. Not 4000: a developer running this is
 * very likely to have `pnpm dev` already bound there, and a load test that
 * silently measured somebody's development server — with its own data, its own
 * `.env` and its own debugger attached — is worse than one that fails to start.
 */
const LOAD_PORT = Number(process.env.LOAD_PORT ?? '4319');
if (!Number.isInteger(LOAD_PORT) || LOAD_PORT < 1 || LOAD_PORT > 65_535) {
  // Checked here rather than left to the server's own config schema: a bad port
  // there surfaces sixty seconds later as "the server did not become live",
  // which names the symptom and not the cause.
  throw new Error(`LOAD_PORT must be a port number; received ${String(process.env.LOAD_PORT)}`);
}

/**
 * `.invalid` is reserved by RFC 2606 and can never resolve, so these addresses
 * cannot collide with a real account and cannot be mistaken for one. Nothing
 * here is a credential: the rows carry no password hash at all, so no password
 * exists to leak and none of them can authenticate. The run's token is minted
 * directly below and lives in one subprocess's environment.
 */
const ADMIN_EMAIL = 'loadtest-admin@example.invalid';
const USER_EMAIL_PREFIX = 'loadtest-user-';

/**
 * Pinned by digest, which is the point of using an image rather than a binary.
 *
 * A latency budget is calibrated against a measuring instrument: k6's own
 * client overhead lands inside `http_req_duration`, so the number in
 * `budgets.ts` is only comparable across runs that used the same k6. An image
 * digest makes CI and a developer's machine run the same one, in the same way
 * `docs/integration-testing.md` pins `postgres:16-alpine` rather than letting
 * each environment bring its own server.
 *
 * k6 v2.4.0. Override with `LOAD_K6_BIN` to use a locally installed k6 — on
 * macOS, where `--network host` does not reach the host, that is the easier
 * route — and read the version it reports before comparing a number to the
 * table in `docs/load-testing.md`.
 */
const K6_IMAGE =
  'grafana/k6@sha256:3d8e5c7f1d53ec59408c2ffbd9943602a0985ffcbd4a2430ec00f3ffca89796e';

interface SeededUsers {
  readonly adminId: string;
  /**
   * The id the cached and conditional rows read, and deliberately *not* a
   * member of `poolIds`.
   *
   * Taken from the rotation pool, it would be re-read by the cached row every
   * ~33ms and so permanently resident in `usersCache` — and the uncached row
   * would then score about five of its 1,800 requests as hits on the one id it
   * is cycling past. Five in 1,800 moves no percentile, but it makes the row
   * mean something slightly other than what it says, which is the thing this
   * profile cannot afford.
   */
  readonly warmId: string;
  /** The ids the uncached row cycles through. */
  readonly poolIds: readonly string[];
}

/**
 * One statement for the pool and one for the administrator, both
 * `ON CONFLICT DO NOTHING`: the rows outlive a run, so the second run of the
 * day inserts nothing and reads the same ids.
 *
 * The administrator is a real row even though nothing reads it. An access token
 * is stateless here — `authenticateRequest` verifies the signature and never
 * looks the subject up — so a made-up subject would measure exactly the same
 * work, and the next reader of this file would have to establish that for
 * themselves before trusting the profile.
 */
async function seedUsers(): Promise<SeededUsers> {
  const pool = getPool();

  const admin = await pool.query<{ id: string }>(
    `INSERT INTO users (email, roles) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [ADMIN_EMAIL, [ADMIN_ROLE]],
  );
  const adminId =
    admin.rows[0]?.id ??
    (await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL]))
      .rows[0]?.id;
  if (adminId === undefined) throw new Error(`could not seed or find ${ADMIN_EMAIL}`);

  // One more than the rotation pool: the first is the warm id and the rest are
  // what the uncached row cycles through. See `SeededUsers.warmId`.
  const seedCount = LOAD_USER_POOL_SIZE + 1;
  await pool.query(
    `INSERT INTO users (email, roles)
     SELECT $1 || n, ARRAY['user']
     FROM generate_series(1, $2) AS n
     ON CONFLICT (email) DO NOTHING`,
    [USER_EMAIL_PREFIX, seedCount],
  );

  // Ordered by the numeric suffix rather than by the email, so the set is the
  // same on every run and a row added by hand cannot shift the pool under it.
  const read = await pool.query<{ id: string }>(
    `SELECT id FROM users
     WHERE email LIKE $1 || '%'
     ORDER BY (regexp_replace(email, '^' || $1, ''))::int
     LIMIT $2`,
    [USER_EMAIL_PREFIX, seedCount],
  );
  const ids = read.rows.map((row) => row.id);
  if (ids.length < seedCount) {
    throw new Error(
      `seeded ${String(ids.length)} of ${String(seedCount)} read users; ` +
        'the uncached row needs more ids than usersCache holds to be uncached at all',
    );
  }

  const [warmId, ...poolIds] = ids;
  if (warmId === undefined) throw new Error('no warm user id');
  return { adminId, warmId, poolIds };
}

/**
 * The server's own output goes to a file and never to a pipe.
 *
 * `requestLogger` writes an access-log line per request and this profile makes
 * 9,000 of them — around 700 KB. A pipe nobody drains holds 64 KB before the
 * *writer* blocks, so partway through the run the server would stop answering,
 * stop responding to SIGTERM, and leave no error anywhere saying the run had
 * been truncated. The same bug is recorded in
 * `boilerplate-python-fastapi/docs/load-testing.md`; it is a property of pipes
 * and not of either framework.
 *
 * The log is kept rather than discarded. It is the only account of what the
 * application did during the run, and the `load` job uploads it with the
 * summary.
 */
function startServer(logPath: string): {
  readonly stop: () => Promise<'exited' | 'killed'>;
} {
  const fd = openSync(logPath, 'w');
  // `node --import tsx` rather than the `tsx` shim, so there is one fewer
  // process between this script and the thing being measured, and so SIGTERM
  // reaches the server rather than a wrapper.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      PORT: String(LOAD_PORT),
      /**
       * Without this the readiness row measures the probe's own cache. The
       * default is 1000ms and the profile probes every ~33ms, so about 149 of
       * every 150 requests would never reach Postgres — a budget on a database
       * round trip with no database round trip under it.
       */
      HEALTH_CACHE_TTL_MS: '0',
      /**
       * The three process-level timers are off for the run. Each takes an
       * advisory lock or claims outbox rows on a schedule, which is work this
       * process would be doing *beside* the requests being measured — a
       * variance source with no counterpart in the thing under test.
       */
      OUTBOX_RELAY_INTERVAL_SECONDS: '0',
      IDEMPOTENCY_PURGE_INTERVAL_SECONDS: '0',
      WS_ENABLED: 'false',
      /**
       * Metrics stay on, because the metrics middleware is the first thing in
       * the stack and its cost is part of every number here. Measuring without
       * it would be measuring a deployment nobody runs.
       */
      METRICS_ENABLED: 'true',
      /**
       * The drain delay is a fixed wait for a load balancer to notice, and
       * there is no load balancer here — it would add five seconds of nothing
       * to the end of every run.
       */
      SHUTDOWN_DRAIN_DELAY_MS: '0',
      /** Tracing off: an exporter in the request path is not what is being measured. */
      OTEL_SDK_DISABLED: 'true',
    },
  });
  closeSync(fd);

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  // Without this, a failure to spawn arrives as an unhandled 'error' event and
  // takes the runner down with a stack trace instead of a sentence.
  child.on('error', (error) => {
    exited = true;
    console.error(`[load] could not start the server: ${error.message}`);
  });

  return {
    stop: async () => {
      if (exited) return 'exited';
      child.kill('SIGTERM');
      for (let waited = 0; waited < 15_000 && !exited; waited += 100) {
        await delay(100);
      }
      if (exited) return 'exited';
      child.kill('SIGKILL');
      return 'killed';
    },
  };
}

async function waitForLiveness(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/health/live`);
      if (response.ok) return;
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `server did not become live on ${baseUrl} within 60s (last: ${lastError}). ` +
      `Its output is in ${join(LOAD_REPORT_DIR, LOAD_SERVER_LOG_FILENAME)}.`,
  );
}

/**
 * Reads the warm user once before the run, for two reasons at once: it is where
 * the entity tag the conditional row needs comes from, and it leaves
 * `usersCache` warm so the cached row's *first* request is a hit like every
 * other one.
 */
async function primeWarmUser(
  baseUrl: string,
  token: string,
  warmId: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/users/${warmId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `priming GET /v1/users/${warmId} answered ${String(response.status)}; ` +
        'the run would have measured that status on two of its five rows',
    );
  }
  const etag = response.headers.get('etag');
  if (etag === null) {
    throw new Error(
      `GET /v1/users/${warmId} returned no ETag, so there is no validator for the ` +
        'conditional row to send. Has `sendWithETag` been dropped from the route?',
    );
  }
  return etag;
}

/**
 * How k6 is invoked, and the inputs it is given.
 *
 * Two routes, one of them the default. `LOAD_K6_BIN` runs a locally installed
 * binary against the script in the working tree; everything else goes through
 * the pinned image. The image is the default because it is the one CI uses and
 * the one the budgets were measured with — see `K6_IMAGE`.
 */
interface K6Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface ProfileInputs {
  readonly baseUrl: string;
  readonly token: string;
  readonly warmId: string;
  readonly etag: string;
  readonly poolIds: readonly string[];
  /** Where the gate will look for the summary, on *this* side of the mount. */
  readonly summaryPath: string;
}

function k6Invocation(inputs: ProfileInputs): K6Invocation {
  const localBin = process.env.LOAD_K6_BIN;
  const native = localBin !== undefined && localBin !== '';

  const env: Record<string, string> = {
    LOAD_BASE_URL: inputs.baseUrl,
    LOAD_ACCESS_TOKEN: inputs.token,
    LOAD_WARM_USER_ID: inputs.warmId,
    LOAD_WARM_USER_ETAG: inputs.etag,
    LOAD_USER_IDS: JSON.stringify(inputs.poolIds),
  };

  /**
   * `--summary-export` rather than a `handleSummary` hook in the profile.
   *
   * The hook would have to be handed an output path through the environment and
   * would have to know which side of the container mount it is on; worse,
   * exporting it *replaces* k6's own end-of-test report, so the run would print
   * nothing a person could read — and a red gate sends its reader to exactly
   * that output. The flag writes the same JSON and leaves the report alone.
   *
   * Inside the container the report directory is mounted at /out, so the path
   * differs between the two routes; it lands at `inputs.summaryPath` either way.
   */
  const exportPath = native ? inputs.summaryPath : `/out/${LOAD_SUMMARY_FILENAME}`;

  // `--no-thresholds` on both routes. The profile declares thresholds only to
  // make k6 emit the per-name submetrics the gate reads; with evaluation off, a
  // declared name that recorded nothing is dropped from the summary instead of
  // reported as a passing `p(95)=0`, which is what the gate's "absent from the
  // summary" refusal depends on. The decision is `pnpm check:load`.
  const k6Args = ['run', '--no-thresholds', '--summary-export', exportPath] as const;

  if (native) {
    return {
      command: localBin,
      args: [...k6Args, join(REPO_ROOT, 'src/tests/load/script.ts')],
      env,
    };
  }

  return {
    command: 'docker',
    args: [
      'run',
      '--rm',
      // The server is on the host's loopback. On Linux — CI, and this
      // repository's own development containers — `--network host` is what
      // reaches it. Elsewhere, set LOAD_K6_BIN to a native k6.
      '--network',
      'host',
      // k6's image runs as uid 12345, which cannot write into a directory owned
      // by whoever checked the repository out. Without this the run ends in one
      // line of k6 log — "could not open ...: permission denied" — and exit 0.
      '--user',
      `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
      ...Object.keys(env).flatMap((name) => ['-e', name]),
      '-v',
      `${join(REPO_ROOT, 'src/tests/load')}:/loadtest:ro`,
      '-v',
      `${join(REPO_ROOT, LOAD_REPORT_DIR)}:/out`,
      '-w',
      '/loadtest',
      K6_IMAGE,
      ...k6Args,
      'script.ts',
    ],
    env,
  };
}

function runK6({ command, args, env }: K6Invocation): Promise<number> {
  return new Promise((resolveExit, rejectSpawn) => {
    const child = spawn(command, [...args], {
      stdio: 'inherit',
      // The token reaches k6 through the environment of one child process and
      // is never written to a file or printed. `docker run -e NAME` (no value)
      // passes it the same way rather than putting it on a command line every
      // `ps` on the machine can read.
      env: { ...process.env, ...env },
    });
    child.on('error', rejectSpawn);
    child.on('exit', (code) => {
      resolveExit(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  if ((process.env.DATABASE_URL ?? '') === '') {
    throw new Error(
      'DATABASE_URL is not set. This gate needs the same Postgres `pnpm test` and ' +
        '`pnpm migrate` want; see docs/load-testing.md.',
    );
  }

  const reportDir = join(REPO_ROOT, LOAD_REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  const serverLogPath = join(reportDir, LOAD_SERVER_LOG_FILENAME);
  const summaryPath = join(reportDir, LOAD_SUMMARY_FILENAME);
  const baseUrl = `http://127.0.0.1:${String(LOAD_PORT)}`;

  const seeded = await seedUsers();
  // Minted here rather than obtained from `POST /v1/auth/login`, which would
  // cost an argon2 verification against a rate limiter, and which this profile
  // deliberately does not exercise: a write path belongs in its own profile
  // with its own budgets.
  const token = signAccessToken({ userId: seeded.adminId, roles: [ADMIN_ROLE] });
  // The runner's own pool goes away before the server starts, so the only
  // connections Postgres sees during the run are the ones being measured.
  await closePool();

  // k6 prints the scenario it is about to run, so this says only where.
  console.log(`[load] driving ${baseUrl}`);

  const server = startServer(serverLogPath);
  try {
    await waitForLiveness(baseUrl);
    const etag = await primeWarmUser(baseUrl, token, seeded.warmId);

    const code = await runK6(
      k6Invocation({
        baseUrl,
        token,
        warmId: seeded.warmId,
        etag,
        poolIds: seeded.poolIds,
        summaryPath,
      }),
    );
    if (code !== 0) {
      throw new Error(
        `k6 exited ${String(code)} without completing the run. A non-zero exit here is ` +
          'k6 itself failing — the budgets are `pnpm check:load`, which this run has not ' +
          'reached.',
      );
    }
  } finally {
    const outcome = await server.stop();
    if (outcome === 'killed') {
      console.error(
        '[load] the server ignored SIGTERM for 15s and was killed. A shutdown task is ' +
          `hanging; ${serverLogPath} has the last thing it did.`,
      );
    }
  }

  console.log(`[load] summary: ${summaryPath}`);
  console.log(`[load] server log: ${serverLogPath}`);
  console.log('[load] now run `pnpm check:load` — it is the half that decides.');
}

main().catch((error: unknown) => {
  console.error(`[load] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
