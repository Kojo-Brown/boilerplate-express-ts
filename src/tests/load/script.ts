/**
 * The load profile. Executed by k6, not by Node — see `docs/load-testing.md`.
 *
 * k6 v0.57 and later run TypeScript directly (the types are stripped, not
 * checked), so this file is a normal member of the project: `pnpm typecheck`
 * checks it against `@types/k6` and `pnpm lint` lints it. That is the reason it
 * lives under `src/` at all. It is in `src/tests/` because
 * `tsconfig.build.json` excludes that subtree wholesale, and a k6 profile in
 * `dist/` would be a file the production image can neither run nor needs.
 *
 * It measures and it does not gate. Nothing in here holds a ceiling: the
 * numbers are in `budgets.ts` and the decision is `check-budget.ts`. The
 * `thresholds` below are the one unavoidable exception to that, and their
 * comment says why.
 */
import http from 'k6/http';
import type { RefinedResponse, ResponseType } from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import type { Options } from 'k6/options';
/**
 * A *type-only* import, and it has to stay type-only.
 *
 * k6 resolves a relative specifier on disk and wants the extension —
 * `'./budgets'` fails with "couldn't be found on local disk at
 * /loadtest/budgets" — while TypeScript's `node` module resolution refuses a
 * specifier ending in `.ts`. There is no spelling of a value import that
 * satisfies both. A type-only import is erased before k6 ever sees it, so it
 * satisfies neither and needs to: the coupling it carries is checked by `pnpm
 * typecheck` and costs nothing at run time.
 *
 * Nothing is duplicated to achieve that. The runtime list of names is
 * `Object.keys(tasks)`, and `tasks` is declared as `Record<LoadRequestName, …>`
 * — so the names this file drives are exactly the names `budgets.ts` declares,
 * checked rather than restated.
 */
import type { LoadRequestName } from './budgets';

/**
 * What `run.ts` hands over. Read once at init time rather than per iteration:
 * `__ENV` is a property read on every access, and an iteration here is a few
 * milliseconds of work that should be the server's and not k6's.
 */
const BASE_URL = requiredEnv('LOAD_BASE_URL');
const ACCESS_TOKEN = requiredEnv('LOAD_ACCESS_TOKEN');
const WARM_USER_ID = requiredEnv('LOAD_WARM_USER_ID');
const WARM_USER_ETAG = requiredEnv('LOAD_WARM_USER_ETAG');
/**
 * The ids the uncached row cycles through, as JSON rather than a delimited
 * string: an id is opaque to this file, and a separator is a bug waiting for
 * the day one contains it.
 */
const USER_IDS: readonly string[] = JSON.parse(requiredEnv('LOAD_USER_IDS')) as string[];

function requiredEnv(name: string): string {
  const value = __ENV[name];
  if (value === undefined || value === '') {
    // Thrown at init time, so it fails before a single request is sent rather
    // than producing a run in which one row measured 401s.
    throw new Error(`${name} is not set. Run this profile through \`pnpm test:load\`.`);
  }
  return value;
}

const AUTHORIZED = { Authorization: `Bearer ${ACCESS_TOKEN}` };

/**
 * The offered load.
 *
 * `constant-arrival-rate` rather than a fixed number of virtual users, because
 * the two measure different things. N users with no wait time is a saturation
 * test: it pushes until something queues, and the latency it reports is the
 * depth of that queue rather than the service's response time. A fixed arrival
 * rate makes the offered load a declared parameter and the response time the
 * thing being measured, which is what a ceiling can be put on.
 *
 * 30 iterations a second for 60 seconds, five requests an iteration: 1,800 per
 * name and ~150 req/s aggregate against one Node process answering in
 * single-digit milliseconds. That is nowhere near the knee, deliberately —
 * finding the knee is a different exercise and wants a ramp, not a ceiling.
 *
 * These two numbers are the profile's and live here, in k6's own options,
 * rather than in `budgets.ts`: that file is imported by Node and must stay
 * importable without k6, and a value imported from it could not be erased the
 * way the type above is. The `minRequests` floors in `budgets.ts` are their one
 * consequence elsewhere, and say so.
 */
const ITERATIONS_PER_SECOND = 30;
const DURATION_SECONDS = 60;

/**
 * What a task is handed. `name` is the key it was found under, which is also
 * the tag it must put on its request — passing it in rather than letting each
 * task write the string again is what makes the two impossible to disagree.
 * Spelled out twice, a task could be keyed `(cached)` and tag `(uncached)`, and
 * the run would gate one row against the other's latency with everything
 * green: the typecheck below cannot see inside a string.
 */
interface TaskContext {
  readonly name: LoadRequestName;
  /** Globally unique across every VU in the scenario. */
  readonly iteration: number;
}

/**
 * One task per budgeted name, and the type is what keeps the two lists one
 * list: a name added to `budgets.ts` without a task here fails to compile, and
 * a task cannot be added without a name — which, because `LOAD_BUDGETS` is
 * keyed by the same union, cannot be added without a budget.
 *
 * Every task asserts its own status code. This is the part that is easy to
 * leave out and expensive to leave out: a 401 is fast and a 404 is faster, so a
 * budget on latency alone passes comfortably against a run in which nothing was
 * authorised — which is the failure a load test is most likely to actually
 * have.
 */
const tasks: Readonly<Record<LoadRequestName, (context: TaskContext) => void>> = {
  'GET /v1/health/live': ({ name }) => {
    expectStatus(name, http.get(`${BASE_URL}/v1/health/live`, { tags: { name } }), 200);
  },

  'GET /v1/health/ready': ({ name }) => {
    expectStatus(name, http.get(`${BASE_URL}/v1/health/ready`, { tags: { name } }), 200);
  },

  'GET /v1/users/:id (cached)': ({ name }) => {
    expectStatus(
      name,
      http.get(`${BASE_URL}/v1/users/${WARM_USER_ID}`, { headers: AUTHORIZED, tags: { name } }),
      200,
    );
  },

  'GET /v1/users/:id (uncached)': ({ name, iteration }) => {
    // `iterationInTest` is unique across every VU in the scenario, so this is a
    // genuine round robin over the pool rather than each VU walking its own
    // prefix of it — which with ten VUs would have kept the first ten ids
    // permanently resident in a 200-entry cache.
    const id = USER_IDS[iteration % USER_IDS.length];
    expectStatus(
      name,
      http.get(`${BASE_URL}/v1/users/${String(id)}`, { headers: AUTHORIZED, tags: { name } }),
      200,
    );
  },

  'GET /v1/users/:id (If-None-Match)': ({ name }) => {
    expectStatus(
      name,
      http.get(`${BASE_URL}/v1/users/${WARM_USER_ID}`, {
        headers: { ...AUTHORIZED, 'If-None-Match': WARM_USER_ETAG },
        tags: { name },
      }),
      304,
    );
  },
};

function expectStatus(
  name: LoadRequestName,
  response: RefinedResponse<ResponseType | undefined>,
  expected: number,
): void {
  // The check's name carries the expected status, so a red run says which
  // answer was wrong rather than only that one was.
  check(response, {
    [`${name} → ${String(expected)}`]: (r) => r.status === expected,
  });
}

/**
 * Only to make the summary contain the rows the gate reads.
 *
 * k6 materialises a tagged submetric — `http_req_duration{name:…}` — if and
 * only if a threshold names it. Without these, a summary holds one aggregate
 * `http_req_duration` for the whole profile and the five rows below are
 * unrecoverable from it.
 *
 * So the predicates are trivially true on purpose, and the run passes
 * `--no-thresholds` on top of that. Both halves matter:
 *
 *   - A real ceiling here would be a second place holding a number, and the
 *     place holding it would be the profile — so a change to what is measured
 *     could move what is gated, in one commit, invisibly.
 *   - `--no-thresholds` additionally drops a *declared but never requested*
 *     submetric from the summary instead of reporting it as present. That is
 *     the behaviour the gate's `absent from the summary` check depends on, and
 *     it is worth knowing why: with thresholds enabled, k6 reports a submetric
 *     that recorded nothing as `p(95)=0` and the threshold on it as **passing**
 *     — so a task deleted from this file would leave k6 green while measuring
 *     nothing at all.
 */
const thresholds: Record<string, string[]> = {};
for (const name of Object.keys(tasks)) {
  thresholds[`http_req_duration{name:${name}}`] = ['p(95)>=0'];
  thresholds[`http_reqs{name:${name}}`] = ['count>=0'];
}

export const options: Options = {
  thresholds,
  scenarios: {
    read_paths: {
      executor: 'constant-arrival-rate',
      rate: ITERATIONS_PER_SECOND,
      timeUnit: '1s',
      duration: `${String(DURATION_SECONDS)}s`,
      preAllocatedVUs: 10,
      /**
       * An iteration is five sequential requests of a few milliseconds each, so
       * steady state needs well under one VU. The allocation is for the case
       * where it is not: 50 covers an iteration taking 1.6 seconds before k6
       * would have to drop one, and a dropped iteration is an error the gate
       * refuses rather than something to absorb quietly.
       */
      maxVUs: 50,
      /**
       * k6 waits this long after the duration for iterations already running.
       * The default is 30s, which would add half a minute of wall clock to
       * every run for work that finished in milliseconds.
       */
      gracefulStop: '5s',
    },
  },
  /**
   * The summary's own percentiles. `p(99)` is not gated — one request in a
   * hundred being slow is the runner's mood rather than a regression — but it
   * is the first thing worth looking at when a p95 moves, so it is printed.
   */
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
  /**
   * Every exchange on one connection per VU, which is what a real client does
   * and what keeps the measurement off the TCP handshake. `http_req_duration`
   * excludes connect and TLS anyway; this keeps them from happening 9,000
   * times.
   */
  noConnectionReuse: false,
  /** The profile authenticates with a bearer token and has no cookie jar. */
  noCookiesReset: true,
};

/**
 * The five requests run in declaration order within one iteration, sharing a
 * connection, so each name sees the same offered load and the same arrival
 * pattern. Interleaving them as separate scenarios would give each its own VU
 * pool and make the five numbers measurements of five different runs.
 */
export default function readPaths(): void {
  const iteration = exec.scenario.iterationInTest;
  for (const name of Object.keys(tasks) as LoadRequestName[]) {
    tasks[name]({ name, iteration });
  }
}
