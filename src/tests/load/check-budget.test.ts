/**
 * The gate's tests.
 *
 * `check-budget.ts` is the thing that decides whether a load run blocks a
 * merge, and the reason it exists as a Node program rather than as five
 * `thresholds` in the k6 profile is that this file can exist: every refusal
 * below is watched failing against a summary built by hand. There is no way to
 * establish the same about `options.thresholds` without a server slow enough to
 * breach them on demand.
 *
 * Every case starts from `passingSummary()` — a faithful copy of the shape
 * `k6 run --summary-export` actually writes, including the two Rate metrics
 * whose polarity is opposite — and changes exactly one thing.
 */
import {
  LOAD_BUDGETS,
  LOAD_REQUEST_NAMES,
  LOAD_USER_POOL_SIZE,
  type LoadRequestName,
} from './budgets';
import {
  LoadGateUsageError,
  evaluateLoadSummary,
  formatLoadTable,
  parseArgs,
  parseLoadSummary,
  type LoadSummary,
} from './check-budget';

const REQUESTS_PER_NAME = 1800;

type Metrics = Record<string, Record<string, unknown>>;

function passingSummary(): LoadSummary {
  const metrics: Metrics = {
    http_reqs: { count: REQUESTS_PER_NAME * LOAD_REQUEST_NAMES.length, rate: 150 },
    // A Rate whose observation is "this request failed": a clean run has
    // `passes: 0`. The `fails` field counts the requests that were *fine*.
    http_req_failed: { passes: 0, fails: REQUESTS_PER_NAME * LOAD_REQUEST_NAMES.length, value: 0 },
    // A Rate whose observation is "this check passed": the opposite polarity,
    // in the same document.
    checks: { passes: REQUESTS_PER_NAME * LOAD_REQUEST_NAMES.length, fails: 0, value: 1 },
  };

  for (const name of LOAD_REQUEST_NAMES) {
    // Comfortably inside every budget, and the same for each row so that a case
    // changing one row cannot be passed by another row's slack.
    metrics[`http_req_duration{name:${name}}`] = { min: 0.4, med: 1, avg: 1.1, 'p(95)': 2, max: 9 };
    metrics[`http_reqs{name:${name}}`] = { count: REQUESTS_PER_NAME, rate: 30 };
  }

  return { metrics };
}

function withMetric(patch: Metrics): LoadSummary {
  const summary = passingSummary();
  return { metrics: { ...summary.metrics, ...patch } };
}

function withoutMetric(...keys: string[]): LoadSummary {
  const metrics = { ...passingSummary().metrics };
  for (const key of keys) delete metrics[key];
  return { metrics };
}

const FIRST: LoadRequestName = LOAD_REQUEST_NAMES[0];
const messages = (summary: LoadSummary, headroom?: number): string[] =>
  evaluateLoadSummary(summary, headroom === undefined ? {} : { headroom }).problems.map(
    (problem) => problem.message,
  );

describe('the budget table itself', () => {
  it('budgets every name the profile may produce, and no others', () => {
    expect(Object.keys(LOAD_BUDGETS).sort()).toEqual([...LOAD_REQUEST_NAMES].sort());
  });

  it('sets every floor below what one run produces', () => {
    // A floor above 1,800 would make the gate permanently red for a reason no
    // change to the service could fix.
    for (const name of LOAD_REQUEST_NAMES) {
      expect(LOAD_BUDGETS[name].minRequests).toBeLessThanOrEqual(REQUESTS_PER_NAME);
      expect(LOAD_BUDGETS[name].minRequests).toBeGreaterThan(0);
    }
  });

  it('sets every ceiling to a positive number of milliseconds', () => {
    for (const name of LOAD_REQUEST_NAMES) {
      expect(LOAD_BUDGETS[name].p95Ms).toBeGreaterThan(0);
    }
  });

  it('cycles through more ids than usersCache can hold', () => {
    // `usersCache` is `new MemoryCacheStore({ maxEntries: 200 })` in
    // `users.controller.ts`. The uncached row is only uncached because the pool
    // is bigger than that; if the cache grows past half of this, the row
    // quietly starts measuring hits and nothing here would say so.
    expect(LOAD_USER_POOL_SIZE).toBeGreaterThan(2 * 200 - 1);
  });
});

describe('a clean run', () => {
  it('reports no problems', () => {
    expect(evaluateLoadSummary(passingSummary()).problems).toEqual([]);
  });

  it('returns one row per budgeted name, all ok', () => {
    const result = evaluateLoadSummary(passingSummary());
    expect(result.rows.map((row) => row.name)).toEqual([...LOAD_REQUEST_NAMES]);
    expect(result.rows.every((row) => row.ok)).toBe(true);
  });

  it('accounts for every request it was told about', () => {
    const result = evaluateLoadSummary(passingSummary());
    expect(result.accountedRequests).toBe(result.totalRequests);
  });

  it('does not read a healthy http_req_failed as 9,000 failures', () => {
    // The regression this guards is one field name. `http_req_failed` exports
    // `fails: 9000` for a run in which nothing failed.
    expect(messages(passingSummary()).join(' ')).not.toContain('request(s) failed');
  });

  it('does not read a healthy checks metric as a failure', () => {
    expect(messages(passingSummary()).join(' ')).not.toContain('check(s) failed');
  });

  it('says nothing about dropped iterations when the metric is absent', () => {
    expect(messages(passingSummary()).join(' ')).not.toContain('dropped');
  });
});

describe('a latency breach', () => {
  it('fails the row whose p95 is over budget', () => {
    const over = LOAD_BUDGETS[FIRST].p95Ms + 1;
    const summary = withMetric({
      [`http_req_duration{name:${FIRST}}`]: { 'p(95)': over },
    });
    const result = evaluateLoadSummary(summary);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toContain('exceeds');
    expect(result.rows.find((row) => row.name === FIRST)?.ok).toBe(false);
  });

  it('passes a p95 exactly on the budget', () => {
    const summary = withMetric({
      [`http_req_duration{name:${FIRST}}`]: { 'p(95)': LOAD_BUDGETS[FIRST].p95Ms },
    });
    expect(evaluateLoadSummary(summary).problems).toEqual([]);
  });

  it('fails a p95 a hundredth of a millisecond over the budget', () => {
    const summary = withMetric({
      [`http_req_duration{name:${FIRST}}`]: { 'p(95)': LOAD_BUDGETS[FIRST].p95Ms + 0.01 },
    });
    expect(evaluateLoadSummary(summary).problems).toHaveLength(1);
  });

  it('reports every breached row rather than stopping at the first', () => {
    const patch: Metrics = {};
    for (const name of LOAD_REQUEST_NAMES) {
      patch[`http_req_duration{name:${name}}`] = { 'p(95)': LOAD_BUDGETS[name].p95Ms * 2 };
    }
    expect(evaluateLoadSummary(withMetric(patch)).problems).toHaveLength(
      LOAD_REQUEST_NAMES.length,
    );
  });

  it('leaves the other rows passing', () => {
    const summary = withMetric({
      [`http_req_duration{name:${FIRST}}`]: { 'p(95)': LOAD_BUDGETS[FIRST].p95Ms * 10 },
    });
    const result = evaluateLoadSummary(summary);
    expect(result.rows.filter((row) => !row.ok).map((row) => row.name)).toEqual([FIRST]);
  });
});

describe('a name that stopped being measured', () => {
  it('refuses a missing duration submetric rather than scoring it 0', () => {
    // This is the whole reason the gate is not five k6 thresholds: k6 scores a
    // submetric that recorded nothing as `p(95)=0`, and `p(95)<60` is satisfied
    // by zero.
    const messaged = messages(withoutMetric(`http_req_duration{name:${FIRST}}`));
    expect(messaged).toHaveLength(1);
    expect(messaged[0]).toContain('absent from the summary');
    expect(messaged[0]).toContain(FIRST);
    // One answer, not two: the row's requests are still attributed to it by
    // `http_reqs{name:…}`, so the accounting check must stay quiet.
    expect(messaged.join(' ')).not.toContain('belong to a budgeted name');
  });

  it('refuses a missing request-count submetric', () => {
    expect(messages(withoutMetric(`http_reqs{name:${FIRST}}`))[0]).toContain(
      'absent from the summary',
    );
  });

  it('refuses a p95 that is not a number', () => {
    const summary = withMetric({
      [`http_req_duration{name:${FIRST}}`]: { 'p(95)': 'N/A' },
    });
    expect(messages(summary)[0]).toContain('absent from the summary');
  });

  it('refuses a p95 that is NaN', () => {
    const summary = withMetric({ [`http_req_duration{name:${FIRST}}`]: { 'p(95)': NaN } });
    expect(messages(summary)[0]).toContain('absent from the summary');
  });

  it('refuses a submetric present but holding no p(95) key', () => {
    const summary = withMetric({ [`http_req_duration{name:${FIRST}}`]: { avg: 1 } });
    expect(messages(summary)[0]).toContain('absent from the summary');
  });

  it('omits an absent row from the table rather than printing a zero', () => {
    const result = evaluateLoadSummary(withoutMetric(`http_req_duration{name:${FIRST}}`));
    expect(result.rows.map((row) => row.name)).not.toContain(FIRST);
  });
});

describe('too few samples', () => {
  it('refuses a name that recorded nothing', () => {
    const summary = withMetric({ [`http_reqs{name:${FIRST}}`]: { count: 0 } });
    expect(messages(summary)[0]).toContain('recorded 0 requests');
  });

  it('refuses a count below the floor', () => {
    const summary = withMetric({
      [`http_reqs{name:${FIRST}}`]: { count: LOAD_BUDGETS[FIRST].minRequests - 1 },
    });
    expect(messages(summary).join(' ')).toContain('below the floor');
  });

  it('accepts a count exactly on the floor', () => {
    const floor = LOAD_BUDGETS[FIRST].minRequests;
    const summary = withMetric({
      [`http_reqs{name:${FIRST}}`]: { count: floor },
      // The aggregate has to agree, or the accounting check fires instead.
      http_reqs: {
        count: floor + REQUESTS_PER_NAME * (LOAD_REQUEST_NAMES.length - 1),
      },
    });
    expect(evaluateLoadSummary(summary).problems).toEqual([]);
  });

  it('still reports a thin row in the table so its p95 is visible', () => {
    const summary = withMetric({ [`http_reqs{name:${FIRST}}`]: { count: 3 } });
    const row = evaluateLoadSummary(summary).rows.find((r) => r.name === FIRST);
    expect(row?.requests).toBe(3);
    expect(row?.ok).toBe(false);
  });
});

describe('requests that belong to no budget', () => {
  it('refuses a run whose aggregate exceeds the sum of its named rows', () => {
    // A task added with a tag nobody budgeted, or with no name tag at all: it
    // is driven, it costs the server capacity, and no row gates it. k6 cannot
    // express this check, which is the other half of why the gate is here.
    const summary = withMetric({
      http_reqs: { count: REQUESTS_PER_NAME * LOAD_REQUEST_NAMES.length + 1800 },
    });
    expect(messages(summary).join(' ')).toContain('belong to a budgeted name');
  });

  it('names how many requests were unaccounted for', () => {
    const summary = withMetric({
      http_reqs: { count: REQUESTS_PER_NAME * LOAD_REQUEST_NAMES.length + 7 },
    });
    expect(messages(summary).join(' ')).toContain('7 request(s)');
  });

  it('refuses a run whose aggregate is smaller than the sum of its rows', () => {
    const summary = withMetric({ http_reqs: { count: 1 } });
    expect(messages(summary).join(' ')).toContain('belong to a budgeted name');
  });

  it('does not count an absent row towards the accounting', () => {
    // Both refusals should fire: the row is gone *and* its requests are now
    // unaccounted for in the aggregate.
    const messaged = messages(withoutMetric(`http_reqs{name:${FIRST}}`));
    expect(messaged.some((m) => m.includes('absent from the summary'))).toBe(true);
    expect(messaged.some((m) => m.includes('belong to a budgeted name'))).toBe(true);
  });
});

describe('a run that measured the wrong thing', () => {
  it('refuses any failed request', () => {
    const summary = withMetric({ http_req_failed: { passes: 1, fails: 8999, value: 0.0001 } });
    expect(messages(summary).join(' ')).toContain('1 request(s) failed');
  });

  it('refuses any failed status check', () => {
    // A 304 row that came back 200 looks like this: fast, successful, and
    // measuring the unconditional read twice.
    const summary = withMetric({ checks: { passes: 8999, fails: 1, value: 0.9999 } });
    expect(messages(summary).join(' ')).toContain('1 status check(s) failed');
  });

  it('refuses a dropped iteration', () => {
    const summary = withMetric({ dropped_iterations: { count: 4, rate: 0.07 } });
    expect(messages(summary).join(' ')).toContain('4 iteration(s) were dropped');
  });

  it('ignores dropped_iterations at zero', () => {
    const summary = withMetric({ dropped_iterations: { count: 0, rate: 0 } });
    expect(evaluateLoadSummary(summary).problems).toEqual([]);
  });

  it('reports every row absent when pointed at a handleSummary-shaped document', () => {
    // A `handleSummary` hook nests each metric under `{ type, contains, values }`
    // while `--summary-export` writes the readings flat. The shapes are close
    // enough to parse as one another, so what matters is that the wrong one
    // cannot pass: every budgeted row reads as absent.
    const nested: LoadSummary = { metrics: {} };
    for (const name of LOAD_REQUEST_NAMES) {
      nested.metrics[`http_req_duration{name:${name}}`] = {
        type: 'trend',
        values: { 'p(95)': 1 },
      };
      nested.metrics[`http_reqs{name:${name}}`] = { type: 'counter', values: { count: 1800 } };
    }
    const problems = evaluateLoadSummary(nested).problems;
    expect(problems).toHaveLength(LOAD_REQUEST_NAMES.length);
    expect(problems.every((problem) => problem.message.includes('absent'))).toBe(true);
  });
});

describe('--headroom', () => {
  it('lets a breach through when multiplied past it', () => {
    const summary = withMetric({
      [`http_req_duration{name:${FIRST}}`]: { 'p(95)': LOAD_BUDGETS[FIRST].p95Ms * 1.5 },
    });
    expect(evaluateLoadSummary(summary).problems).toHaveLength(1);
    expect(evaluateLoadSummary(summary, { headroom: 2 }).problems).toEqual([]);
  });

  it('reports the multiplied ceiling in the row, not the committed one', () => {
    const row = evaluateLoadSummary(passingSummary(), { headroom: 3 }).rows.find(
      (r) => r.name === FIRST,
    );
    expect(row?.budgetMs).toBe(LOAD_BUDGETS[FIRST].p95Ms * 3);
  });

  it('refuses a multiplier below 1 rather than clamping it', () => {
    // `--headroom 0.5` is somebody trying to tighten the gate for one run.
    expect(() => evaluateLoadSummary(passingSummary(), { headroom: 0.5 })).toThrow(
      LoadGateUsageError,
    );
  });

  it('refuses a multiplier that is not a number', () => {
    expect(() => evaluateLoadSummary(passingSummary(), { headroom: NaN })).toThrow(
      LoadGateUsageError,
    );
  });

  it('accepts exactly 1', () => {
    expect(evaluateLoadSummary(passingSummary(), { headroom: 1 }).problems).toEqual([]);
  });
});

describe('parseLoadSummary', () => {
  it('parses a real export', () => {
    expect(parseLoadSummary(JSON.stringify(passingSummary()), 'x.json').metrics).toHaveProperty(
      'http_reqs',
    );
  });

  it('refuses a truncated file with an actionable message', () => {
    expect(() => parseLoadSummary('{"metrics": {', 'x.json')).toThrow(/not valid JSON/);
  });

  it('refuses a document with no metrics object', () => {
    expect(() => parseLoadSummary('{"root_group":{}}', 'x.json')).toThrow(
      /not a k6 end-of-test summary/,
    );
  });

  it('names the file it could not read', () => {
    expect(() => parseLoadSummary('nope', 'reports/load/summary.json')).toThrow(
      /reports\/load\/summary\.json/,
    );
  });
});

describe('parseArgs', () => {
  it('defaults to the path pnpm test:load writes', () => {
    expect(parseArgs([])).toEqual({ summaryPath: 'reports/load/summary.json', headroom: 1 });
  });

  it('takes an alternative summary path', () => {
    expect(parseArgs(['--summary', '/tmp/s.json']).summaryPath).toBe('/tmp/s.json');
  });

  it('takes a headroom multiplier', () => {
    expect(parseArgs(['--headroom', '2.5']).headroom).toBe(2.5);
  });

  it('takes both', () => {
    expect(parseArgs(['--summary', 'a.json', '--headroom', '2'])).toEqual({
      summaryPath: 'a.json',
      headroom: 2,
    });
  });

  it('refuses --summary with no value', () => {
    expect(() => parseArgs(['--summary'])).toThrow(LoadGateUsageError);
  });

  it('refuses --headroom with no value', () => {
    expect(() => parseArgs(['--headroom'])).toThrow(LoadGateUsageError);
  });

  it('refuses a non-numeric headroom', () => {
    expect(() => parseArgs(['--headroom', 'fast'])).toThrow(/must be a number/);
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    expect(() => parseArgs(['--budget', '500'])).toThrow(/unknown argument/);
  });
});

describe('formatLoadTable', () => {
  it('prints every budgeted name', () => {
    const table = formatLoadTable(evaluateLoadSummary(passingSummary()));
    for (const name of LOAD_REQUEST_NAMES) expect(table).toContain(name);
  });

  it('marks a breached row FAIL and leaves the rest ok', () => {
    const summary = withMetric({
      [`http_req_duration{name:${FIRST}}`]: { 'p(95)': LOAD_BUDGETS[FIRST].p95Ms * 2 },
    });
    const table = formatLoadTable(evaluateLoadSummary(summary));
    expect(table).toContain('FAIL');
    expect(table.split('\n').filter((line) => line.startsWith('ok'))).toHaveLength(
      LOAD_REQUEST_NAMES.length - 1,
    );
  });

  it('prints the budget beside the measurement, so a red run shows both', () => {
    const table = formatLoadTable(evaluateLoadSummary(passingSummary()));
    expect(table).toContain(`${String(LOAD_BUDGETS[FIRST].p95Ms)}ms`);
  });

  it('prints sub-10ms readings to two decimals and larger ones whole', () => {
    const table = formatLoadTable(evaluateLoadSummary(passingSummary()));
    expect(table).toContain('2.00ms');
  });
});
