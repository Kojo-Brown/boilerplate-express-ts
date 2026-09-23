import { env, envSchemaWithInvariants } from '@/config/env';

describe('env', () => {
  it('is frozen in every environment, not only in dev', () => {
    // Fifteen modules import this and treat it as a constant, and it is walked
    // exactly once at boot — there is no hot path here to buy back by making
    // the freeze conditional.
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('rejects the write a test reaches for to force a branch', () => {
    expect(() => {
      // The cast is what such a test would have to write now: `env` is typed
      // `DeepReadonly`, so the assignment is a compile error first. Without the
      // freeze it would succeed, leak into every later test in that file, and
      // fail somewhere else entirely.
      (env as { NODE_ENV: string }).NODE_ENV = 'production';
    }).toThrow(TypeError);

    expect(env.NODE_ENV).toBe('test');
  });

  it('leaves tracing off unless a deployment asks for it', () => {
    // Asserted on `env` rather than on `resolveTracingConfig`, because what this
    // pins is the *default*: nothing in `jest.setup.ts` turns tracing off, so if
    // the schema's default ever became `console` or `otlp`, every suite in this
    // repository would start patching modules and opening an exporter. The two
    // in-process tracing suites register their own providers deliberately; none
    // of the other hundred and fifty should acquire one by accident.
    expect(env.OTEL_TRACES_EXPORTER).toBe('none');
    expect(env.OTEL_SDK_DISABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('');
  });

  it('leaves metrics on, which is the opposite default from tracing', () => {
    // Asserted because the asymmetry looks like an oversight and is not: a
    // tracer with no collector patches every instrumented module and fails
    // outward every few seconds, where a registry nobody scrapes is three
    // counters in memory. See docs/metrics.md.
    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.METRICS_PATH).toBe('/metrics');
    expect(env.METRICS_DEFAULT_METRICS).toBe(true);
  });

  it('caps route labels by default rather than trusting the router', () => {
    // The default that prevents an outage rather than enabling a graph. A
    // boilerplate shipping this unset would hand its first user an unbounded
    // `route` label the moment they mount a router on a parameterised path.
    expect(env.METRICS_MAX_ROUTE_LABELS).toBe(200);
  });

  it('leaves exemplars off, because turning them on changes the wire format', () => {
    // `true` here would switch every deployment's exposition to OpenMetrics as
    // a side effect of upgrading, and would refuse to boot wherever tracing is
    // off — which, per the default above, is everywhere.
    expect(env.METRICS_EXEMPLARS).toBe(false);
  });

  it('keeps every trace whole by default', () => {
    // A boilerplate that ships sampling at less than 1 hands its first user an
    // incomplete trace and no clue why. Lowering it is a decision made against a
    // real export bill.
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe(1);
  });

  it('gives a readiness check less time than any prober will give the probe', () => {
    // The number that has to stay under the probe's own `timeoutSeconds`, whose
    // usual value is 5. When it does not, the prober gives up first and every
    // dependency incident is reported as "probe timed out" with no indication
    // of which dependency — the one failure of this subsystem that produces no
    // information at all. Per check rather than for the set, because the checks
    // run concurrently.
    expect(env.HEALTH_CHECK_TIMEOUT_MS).toBe(2_000);
  });

  it('caches a readiness report for long enough to collapse pollers and no longer', () => {
    // A cached report is stale in both directions, so this is also how long a
    // failed dependency keeps being reported healthy. An order of magnitude
    // below the probe interval merges the kubelet, the balancer nodes, the mesh
    // and the uptime monitor into one set of checks; at the probe interval it
    // silently halves the rate at which anything is noticed.
    expect(env.HEALTH_CACHE_TTL_MS).toBe(1_000);
  });

  it('keeps dependency failure reasons out of the response by default', () => {
    // A readiness endpoint is routinely reachable from further away than the
    // API it guards, and a `pg` connection error names the host, port and
    // database it could not reach.
    expect(env.HEALTH_EXPOSE_ERRORS).toBe(false);
  });

  it('never tells a prober to retry immediately', () => {
    // 0 reads as flapping rather than as leaving, on both the drain answer and
    // the dependency one.
    expect(env.HEALTH_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });
});

describe('env — CORS and security header defaults', () => {
  it('ships a named origin rather than a wildcard', () => {
    // The default a boilerplate is judged by. `*` here would mean every repo
    // started from this one allows any page on the internet to read its API
    // until someone notices.
    expect(env.CORS_ORIGIN).toBe('http://localhost:3000');
    expect(env.CORS_ALLOW_CREDENTIALS).toBe(false);
  });

  it('exposes ETag, without which the concurrency layer degrades silently', () => {
    // A cross-origin `fetch` can read only the safelisted six otherwise, so the
    // client never sees the ETag, never sends `If-Match`, and every guarded
    // write quietly becomes last-write-wins for exactly the callers the
    // optimistic-concurrency module was built for.
    expect(env.CORS_EXPOSED_HEADERS.split(',')).toContain('ETag');
  });

  it('accepts the request headers this API actually reads cross-origin', () => {
    const allowed = env.CORS_ALLOWED_HEADERS.split(',');

    expect(allowed).toContain('Authorization');
    expect(allowed).toContain('Idempotency-Key');
    expect(allowed).toContain('If-Match');
  });

  it('enforces a CSP by default and reports nowhere, having no documents to report on', () => {
    expect(env.CSP_ENABLED).toBe(true);
    expect(env.CSP_REPORT_ONLY).toBe(false);
    expect(env.CSP_REPORT_URI).toBe('');
  });

  it('sends HSTS by default but never preloads without being asked', () => {
    // Preload is the one setting here that is not reversible on your own
    // schedule, so it is the one that has to be opted into.
    expect(env.HSTS_MAX_AGE_SECONDS).toBe(15_552_000);
    expect(env.HSTS_INCLUDE_SUBDOMAINS).toBe(true);
    expect(env.HSTS_PRELOAD).toBe(false);
  });
});

describe('env — security invariants', () => {
  // `process.env` under `jest.setup.ts` is a valid environment, so each case
  // states only the pair it is about and inherits the rest.
  const parse = (overrides: Record<string, string>) =>
    envSchemaWithInvariants.safeParse({ ...process.env, ...overrides });

  const pathsIn = (result: ReturnType<typeof parse>): string[] =>
    result.success ? [] : result.error.issues.flatMap((issue) => issue.path.map(String));

  it('refuses a wildcard origin paired with credentials', () => {
    // Either the middleware ignores one of the two settings, so the operator's
    // belief is false and nothing says so, or it honours both and every site
    // on the internet can act as the logged-in user. Neither is a default
    // worth having, so boot fails instead.
    const result = parse({ CORS_ORIGIN: '*', CORS_ALLOW_CREDENTIALS: 'true' });

    expect(result.success).toBe(false);
    expect(pathsIn(result)).toContain('CORS_ORIGIN');
  });

  it('allows a wildcard origin on its own', () => {
    expect(parse({ CORS_ORIGIN: '*', CORS_ALLOW_CREDENTIALS: 'false' }).success).toBe(true);
  });

  it('allows credentials against a named origin', () => {
    expect(
      parse({ CORS_ORIGIN: 'https://app.example.test', CORS_ALLOW_CREDENTIALS: 'true' }).success,
    ).toBe(true);
  });

  it('refuses a preload that would not qualify for the list it advertises to', () => {
    const shortMaxAge = parse({ HSTS_PRELOAD: 'true', HSTS_MAX_AGE_SECONDS: '86400' });
    expect(shortMaxAge.success).toBe(false);
    expect(pathsIn(shortMaxAge)).toContain('HSTS_MAX_AGE_SECONDS');

    const noSubdomains = parse({
      HSTS_PRELOAD: 'true',
      HSTS_MAX_AGE_SECONDS: '31536000',
      HSTS_INCLUDE_SUBDOMAINS: 'false',
    });
    expect(noSubdomains.success).toBe(false);
    expect(pathsIn(noSubdomains)).toContain('HSTS_INCLUDE_SUBDOMAINS');
  });

  it('accepts a preload that does qualify', () => {
    expect(
      parse({
        HSTS_PRELOAD: 'true',
        HSTS_MAX_AGE_SECONDS: '31536000',
        HSTS_INCLUDE_SUBDOMAINS: 'true',
      }).success,
    ).toBe(true);
  });

  it('refuses report-only with no collector, which enforces nothing and records nothing', () => {
    const result = parse({ CSP_REPORT_ONLY: 'true', CSP_REPORT_URI: '' });

    expect(result.success).toBe(false);
    expect(pathsIn(result)).toContain('CSP_REPORT_URI');
  });

  it('refuses a key ring whose active key it does not hold', () => {
    // The mistake that breaks the second phase of a key rotation: the active
    // id is advanced before the key itself has reached every instance. At boot
    // this is a deployment that does not start. Missed, it is every write to
    // an encrypted column failing, on the instances that rolled first.
    const result = parse({ FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'not-in-the-ring' });

    expect(result.success).toBe(false);
    expect(pathsIn(result)).toContain('FIELD_ENCRYPTION_KEYS');
  });

  it('refuses key material that is not 32 bytes, at boot rather than at first write', () => {
    const result = parse({
      FIELD_ENCRYPTION_KEYS: `k1:${Buffer.from('too-short').toString('base64')}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    });

    expect(result.success).toBe(false);
    expect(pathsIn(result)).toContain('FIELD_ENCRYPTION_KEYS');
  });

  it('keeps key material out of the message it prints when it refuses', () => {
    // The boot failure prints these issues to stdout, which is where a log
    // shipper picks them up. A config error is also exactly when somebody is
    // pasting keys around.
    const key = Buffer.alloc(31, 7).toString('base64');
    const result = parse({
      FIELD_ENCRYPTION_KEYS: `k1:${key}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    });

    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages.join(' ')).toContain('k1');
    expect(messages.join(' ')).not.toContain(key);
  });

  it('accepts a ring holding a retired key beside the active one', () => {
    // The state a rotation spends most of its life in, and the reason this is
    // a ring rather than a key.
    expect(
      parse({
        FIELD_ENCRYPTION_KEYS:
          'old:dGVzdC1maWVsZC1lbmNyeXB0aW9uLWtleS0wMDAwMDE=,' +
          'new:dGVzdC1maWVsZC1lbmNyeXB0aW9uLWtleS0wMDAwMDI=',
        FIELD_ENCRYPTION_ACTIVE_KEY_ID: 'new',
      }).success,
    ).toBe(true);
  });

  it('accepts report-only once a collector is named', () => {
    expect(
      parse({
        CSP_REPORT_ONLY: 'true',
        CSP_REPORT_URI: 'https://csp.example.test/report',
      }).success,
    ).toBe(true);
  });
});
