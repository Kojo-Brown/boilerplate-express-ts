/**
 * The gate: `pnpm check:load`.
 *
 * It reads the summary `pnpm test:load` wrote and decides whether the run
 * passes. Every number it gates on is in `budgets.ts`; everything here is the
 * reading of them, and the three refusals that are not about a percentile at
 * all.
 *
 * Why this is a second command rather than five `thresholds` in the k6 profile,
 * which is what k6 is built for:
 *
 *   - **A threshold cannot fail for want of data.** k6 reports a tagged
 *     submetric that recorded nothing as `p(95)=0`, and `p(95)<75` is satisfied
 *     by zero — so a task renamed, deleted, or raising before it sends leaves
 *     the run green having measured nothing. That is verified behaviour, not a
 *     worry; see `docs/load-testing.md`.
 *   - **A threshold has no tests.** Everything below is exercised by
 *     `check-budget.test.ts` against summaries built by hand, including every
 *     refusal. There is no way to prove `options.thresholds` fails when it
 *     should without a server slow enough to make it, and a gate nobody has
 *     watched fail is a gate nobody should trust.
 *   - **A threshold in the profile puts the ceiling in the file that decides
 *     what is measured.** One commit could then move both.
 *
 * It is the same measure-then-gate split as `pnpm test:mutation` and
 * `thresholds.break`, for the same reason: the measuring tool's exit code
 * answers a different question from the one that should block a merge.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  LOAD_BUDGETS,
  LOAD_REQUEST_NAMES,
  LOAD_REPORT_DIR,
  LOAD_SUMMARY_FILENAME,
  type LoadRequestName,
} from './budgets';

/**
 * The parts of a k6 `--summary-export` document this gate reads: a `metrics`
 * object whose keys are metric names — `http_reqs`, and one
 * `http_req_duration{name:…}` per tagged submetric — each mapping straight to
 * its readings.
 *
 * Note the shape. A `handleSummary` hook receives each metric wrapped in
 * `{ type, contains, values }`; `--summary-export` writes the readings
 * unwrapped. They are not interchangeable, which is worth knowing before
 * pointing this gate at a file produced the other way.
 *
 * Deliberately permissive about everything else: k6 adds metrics between
 * versions, and a gate that refused an unfamiliar key would fail on an upgrade
 * rather than on a regression. Each reading is `unknown` so that a missing or
 * non-numeric one is reported by `readNumber` with the metric's name in the
 * message, instead of as a schema error thirty lines long.
 */
const summarySchema = z.object({
  metrics: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export type LoadSummary = z.infer<typeof summarySchema>;

/** The failing gate's output: one line per problem, in the order found. */
export interface LoadGateProblem {
  readonly name: LoadRequestName | null;
  readonly message: string;
}

/** One row of the printed table, whether or not it passed. */
export interface LoadGateRow {
  readonly name: LoadRequestName;
  readonly p95Ms: number;
  readonly budgetMs: number;
  readonly requests: number;
  readonly minRequests: number;
  readonly ok: boolean;
}

export interface LoadGateResult {
  readonly rows: readonly LoadGateRow[];
  readonly problems: readonly LoadGateProblem[];
  readonly totalRequests: number;
  readonly accountedRequests: number;
}

export interface LoadGateOptions {
  /**
   * Multiplies every ceiling. For running the gate on hardware slower than the
   * table in `docs/load-testing.md` was measured on — which is what it is for,
   * and the only reason it exists: the alternative is editing `LOAD_BUDGETS`,
   * and an edit to the committed numbers to get a local run green is how a
   * ceiling quietly becomes whatever the slowest machine needed.
   *
   * It can only loosen. A value below 1 is refused rather than clamped, because
   * `--headroom 0.5` is somebody trying to tighten the gate for one run and
   * they should be told it is not the tool for that.
   */
  readonly headroom?: number;
}

export class LoadGateUsageError extends Error {}

function readNumber(summary: LoadSummary, metric: string, key: string): number | null {
  const found = summary.metrics[metric];
  if (found === undefined) return null;
  const value = found[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const durationMetric = (name: LoadRequestName): string => `http_req_duration{name:${name}}`;
const countMetric = (name: LoadRequestName): string => `http_reqs{name:${name}}`;

/**
 * The whole decision. Pure: it takes a parsed summary and returns what is wrong
 * with it, so every branch below has a test.
 */
export function evaluateLoadSummary(
  summary: LoadSummary,
  options: LoadGateOptions = {},
): LoadGateResult {
  const headroom = options.headroom ?? 1;
  if (!Number.isFinite(headroom) || headroom < 1) {
    throw new LoadGateUsageError(
      `--headroom must be a number >= 1 (it can only loosen a budget, never tighten one); received ${String(options.headroom)}`,
    );
  }

  const rows: LoadGateRow[] = [];
  const problems: LoadGateProblem[] = [];
  let accountedRequests = 0;

  for (const name of LOAD_REQUEST_NAMES) {
    const budget = LOAD_BUDGETS[name];
    const ceilingMs = budget.p95Ms * headroom;
    const p95 = readNumber(summary, durationMetric(name), 'p(95)');
    const requests = readNumber(summary, countMetric(name), 'count');

    // Counted before the absence check below, so that a row whose latency went
    // missing does not also show up as unaccounted-for traffic. The two
    // refusals answer different questions and a reader should get one answer.
    if (requests !== null) accountedRequests += requests;

    // Absent rather than slow. A name the profile no longer produces would
    // otherwise stop being measured with nothing going red — the single most
    // likely way for this gate to rot.
    if (p95 === null || requests === null) {
      problems.push({
        name,
        message: `"${name}" is absent from the summary — the profile no longer produces it, or its name changed. Nothing was measured for it.`,
      });
      continue;
    }

    if (requests === 0) {
      problems.push({
        name,
        message: `"${name}" recorded 0 requests. The task raised before sending.`,
      });
      continue;
    }

    const ok = p95 <= ceilingMs && requests >= budget.minRequests;
    rows.push({
      name,
      p95Ms: p95,
      budgetMs: ceilingMs,
      requests,
      minRequests: budget.minRequests,
      ok,
    });

    if (requests < budget.minRequests) {
      problems.push({
        name,
        message: `"${name}" was measured over ${String(requests)} requests, below the floor of ${String(budget.minRequests)}. A p95 over too few samples is not a p95 — the server could not keep up with the offered rate, or the profile stopped driving this path every iteration.`,
      });
    }

    if (p95 > ceilingMs) {
      problems.push({
        name,
        message: `"${name}" p95 ${fmt(p95)}ms exceeds ${fmt(ceilingMs)}ms.`,
      });
    }
  }

  const totalRequests = readNumber(summary, 'http_reqs', 'count') ?? 0;

  /**
   * Every request the run made has to belong to exactly one budgeted row.
   *
   * This is the check k6 cannot express at all, and it is what closes the gap
   * the other direction from "a budgeted name went missing": a task added with
   * a tag nobody budgeted, or with no `name` tag, lands in the aggregate and in
   * no submetric, so it would be driven, would consume the server's capacity,
   * and would be gated by nothing. Adding a path is then a deliberate edit to
   * `LOAD_BUDGETS` with a number to justify.
   */
  if (totalRequests !== accountedRequests) {
    problems.push({
      name: null,
      message: `${String(totalRequests)} requests were made but only ${String(accountedRequests)} belong to a budgeted name. ${String(totalRequests - accountedRequests)} request(s) carried a name tag with no budget, or no name tag at all — add them to LOAD_BUDGETS or stop sending them.`,
    });
  }

  /**
   * Failures are zero outright. Every task asserts its own status, so a failure
   * here is a 401, a 503, or a 304 that came back 200 — in each case the run
   * measured something other than what it claims to, and usually something
   * *faster* than the response it replaced.
   */
  /**
   * `passes`, not `fails`, and the inversion is not a typo.
   *
   * `http_req_failed` is a k6 *Rate*, and a Rate counts the observations that
   * were **true** as `passes`. The observation here is "this request failed",
   * so a clean run exports `passes: 0, fails: 9000` — nine thousand requests
   * that were not failures. Read the other way round, this check would fire on
   * every healthy run and go quiet on a run where everything broke.
   *
   * `checks` below is a Rate too, and its observation is "this check passed",
   * so there the field to read genuinely is `fails`. Two Rates, opposite
   * polarity, adjacent in the same summary.
   */
  const failedRequests = readNumber(summary, 'http_req_failed', 'passes');
  if (failedRequests !== null && failedRequests > 0) {
    problems.push({
      name: null,
      message: `${String(failedRequests)} request(s) failed. k6's own output names them; the server's side is in ${join(LOAD_REPORT_DIR, 'server.log')}.`,
    });
  }

  const failedChecks = readNumber(summary, 'checks', 'fails');
  if (failedChecks !== null && failedChecks > 0) {
    problems.push({
      name: null,
      message: `${String(failedChecks)} status check(s) failed — a path answered something other than the status its task requires.`,
    });
  }

  /**
   * k6 drops an iteration when the arrival rate cannot be met from `maxVUs`.
   * It is not a latency breach and it is not noise: it means the offered load
   * stopped being the declared one partway through, so every percentile in the
   * run is a percentile of some other, lighter test.
   */
  const dropped = readNumber(summary, 'dropped_iterations', 'count');
  if (dropped !== null && dropped > 0) {
    problems.push({
      name: null,
      message: `${String(dropped)} iteration(s) were dropped: k6 could not sustain the profile's arrival rate from its VU pool, so the run did not offer the load these budgets were measured at.`,
    });
  }

  return { rows, problems, totalRequests, accountedRequests };
}

function fmt(ms: number): string {
  return ms >= 10 ? ms.toFixed(0) : ms.toFixed(2);
}

/**
 * The table, printed whether the gate passes or fails — a green run is the only
 * place the current numbers are visible, and they are what the next change to a
 * budget has to be argued against.
 */
export function formatLoadTable(result: LoadGateResult): string {
  const header = ['', 'request', 'p95', 'budget', 'requests'];
  const body = result.rows.map((row) => [
    row.ok ? 'ok' : 'FAIL',
    row.name,
    `${fmt(row.p95Ms)}ms`,
    `${fmt(row.budgetMs)}ms`,
    String(row.requests),
  ]);
  const widths = header.map((_, column) =>
    Math.max(...[header, ...body].map((cells) => (cells[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();

  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)].join(
    '\n',
  );
}

export function parseLoadSummary(raw: string, source: string): LoadSummary {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new LoadGateUsageError(
      `${source} is not valid JSON. A truncated summary means k6 was killed mid-write; re-run \`pnpm test:load\`.`,
      { cause },
    );
  }

  const parsed = summarySchema.safeParse(json);
  if (!parsed.success) {
    throw new LoadGateUsageError(
      `${source} is not a k6 end-of-test summary (no \`metrics\` object). ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export interface ParsedArgs {
  readonly summaryPath: string;
  readonly headroom: number;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let summaryPath = join(LOAD_REPORT_DIR, LOAD_SUMMARY_FILENAME);
  let headroom = 1;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--summary') {
      if (value === undefined) throw new LoadGateUsageError('--summary needs a path');
      summaryPath = value;
      index += 1;
    } else if (flag === '--headroom') {
      if (value === undefined) throw new LoadGateUsageError('--headroom needs a number');
      headroom = Number(value);
      if (!Number.isFinite(headroom)) {
        throw new LoadGateUsageError(`--headroom must be a number; received ${value}`);
      }
      index += 1;
    } else {
      throw new LoadGateUsageError(
        `unknown argument ${String(flag)}. Usage: pnpm check:load [--summary <path>] [--headroom <multiplier>]`,
      );
    }
  }

  return { summaryPath, headroom };
}

function main(argv: readonly string[]): number {
  const { summaryPath, headroom } = parseArgs(argv);

  let raw: string;
  try {
    raw = readFileSync(summaryPath, 'utf8');
  } catch {
    console.error(
      `[load] no summary at ${summaryPath}. Run \`pnpm test:load\` first — it is the half that measures.`,
    );
    return 1;
  }

  const result = evaluateLoadSummary(parseLoadSummary(raw, summaryPath), { headroom });

  console.log(formatLoadTable(result));
  if (headroom !== 1) {
    console.log(`\n[load] budgets multiplied by --headroom ${String(headroom)}.`);
  }

  if (result.problems.length === 0) {
    console.log(
      `\n[load] ${String(result.totalRequests)} requests, every p95 within budget.`,
    );
    return 0;
  }

  console.error(`\n[load] ${String(result.problems.length)} problem(s):`);
  for (const problem of result.problems) {
    console.error(`  - ${problem.message}`);
  }
  console.error(
    '\n[load] Do not lower a budget to turn this green. See docs/load-testing.md.',
  );
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LoadGateUsageError) {
      console.error(`[load] ${error.message}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
