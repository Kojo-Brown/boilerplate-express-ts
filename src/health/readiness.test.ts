import { createReadinessProbe, redactReport } from '@/health/readiness';
import type { DependencyCheck, HealthLogger, ReadinessReport } from '@/health/health.types';

function check(
  name: string,
  criticality: DependencyCheck['criticality'],
  run: DependencyCheck['run'],
): DependencyCheck {
  return { name, criticality, run };
}

const passing = (name: string, criticality: DependencyCheck['criticality'] = 'critical') =>
  check(name, criticality, () => Promise.resolve());

const failing = (
  name: string,
  criticality: DependencyCheck['criticality'] = 'critical',
  message = 'unreachable',
) => check(name, criticality, () => Promise.reject(new Error(message)));

function recordingLogger(): HealthLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (message) => lines.push(message),
    warn: (message) => lines.push(message),
  };
}

/** A clock the test moves by hand, so the TTL is exercised without waiting. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('createReadinessProbe', () => {
  const silent: HealthLogger = { log: () => {}, warn: () => {} };

  it('is ok with nothing registered', async () => {
    // The state every e2e suite here builds an app into. A process that depends
    // on nothing is ready as soon as it is listening.
    const probe = createReadinessProbe({
      checks: () => [],
      timeoutMs: 100,
      cacheTtlMs: 0,
      logger: silent,
    });

    expect(await probe.evaluate()).toMatchObject({ status: 'ok', checks: [] });
  });

  it('is unready when a critical check fails', async () => {
    const probe = createReadinessProbe({
      checks: () => [passing('redis', 'optional'), failing('postgres', 'critical')],
      timeoutMs: 100,
      cacheTtlMs: 0,
      logger: silent,
    });

    expect((await probe.evaluate()).status).toBe('unready');
  });

  it('is degraded — not unready — when only an optional check fails', async () => {
    // The decision this whole classification exists for: Redis is down for every
    // replica, so taking them all out of the load balancer helps nobody and
    // turns an events backlog into an outage.
    const probe = createReadinessProbe({
      checks: () => [passing('postgres', 'critical'), failing('redis', 'optional')],
      timeoutMs: 100,
      cacheTtlMs: 0,
      logger: silent,
    });

    const report = await probe.evaluate();
    expect(report.status).toBe('degraded');
    expect(report.checks.map((result) => [result.name, result.status])).toEqual([
      ['postgres', 'ok'],
      ['redis', 'failed'],
    ]);
  });

  it('lets one failed critical check outrank any number of healthy ones', async () => {
    const probe = createReadinessProbe({
      checks: () => [passing('a'), passing('b'), failing('c'), passing('d')],
      timeoutMs: 100,
      cacheTtlMs: 0,
      logger: silent,
    });

    expect((await probe.evaluate()).status).toBe('unready');
  });

  it('reads the registry on every evaluation rather than capturing it', async () => {
    // Registration happens in `server.ts`, after `createApp()` has built the
    // router holding the probe. Capturing the list at construction would give a
    // probe that checks nothing, forever, while answering ok.
    const registry: DependencyCheck[] = [];
    const probe = createReadinessProbe({
      checks: () => registry,
      timeoutMs: 100,
      cacheTtlMs: 0,
      logger: silent,
    });

    expect((await probe.evaluate()).checks).toEqual([]);

    registry.push(failing('postgres'));
    expect((await probe.evaluate()).status).toBe('unready');
  });

  describe('collapsing pollers', () => {
    it('serves a cached report until the TTL expires', async () => {
      const clock = fakeClock();
      let runs = 0;
      const probe = createReadinessProbe({
        checks: () => [
          check('postgres', 'critical', () => {
            runs += 1;
            return Promise.resolve();
          }),
        ],
        timeoutMs: 100,
        cacheTtlMs: 1_000,
        logger: silent,
        now: clock.now,
      });

      await probe.evaluate();
      clock.advance(999);
      await probe.evaluate();
      expect(runs).toBe(1);

      clock.advance(1);
      await probe.evaluate();
      expect(runs).toBe(2);
    });

    it('drops a cached report the clock has moved behind', async () => {
      // `Date.now()` is a wall clock, and a backwards NTP step makes a report
      // look arbitrarily far in the future. Compared only against the upper
      // bound, that would pin readiness to one stale answer until the clock
      // caught up — which can be minutes, on the probe that decides routing.
      const clock = fakeClock();
      let runs = 0;
      const probe = createReadinessProbe({
        checks: () => [
          check('postgres', 'critical', () => {
            runs += 1;
            return Promise.resolve();
          }),
        ],
        timeoutMs: 100,
        cacheTtlMs: 60_000,
        logger: silent,
        now: clock.now,
      });

      await probe.evaluate();
      expect(runs).toBe(1);

      clock.advance(-30_000);
      await probe.evaluate();
      expect(runs).toBe(2);
    });

    it('dates a report at the instant the checks began, not when they finished', async () => {
      // Otherwise a check that spent its whole budget would stay cached for the
      // TTL *on top of* that budget, and the worst-case staleness would be the
      // sum rather than the number an operator configured.
      const clock = fakeClock();
      const probe = createReadinessProbe({
        checks: () => [
          check('slow', 'critical', async () => {
            clock.advance(500);
            await Promise.resolve();
          }),
        ],
        timeoutMs: 1_000,
        cacheTtlMs: 1_000,
        logger: silent,
        now: clock.now,
      });

      expect((await probe.evaluate()).checkedAt).toBe(1_000);
    });

    it('joins an evaluation already in flight instead of starting a second', async () => {
      // The half that matters during an incident: a check takes its full budget
      // and every poller that arrives inside it would otherwise take its own
      // pool client, at the moment clients are what the pool has run out of.
      let runs = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const probe = createReadinessProbe({
        checks: () => [
          check('postgres', 'critical', async () => {
            runs += 1;
            await gate;
          }),
        ],
        timeoutMs: 1_000,
        // Cache off, so nothing but the single-flight can be doing this.
        cacheTtlMs: 0,
        logger: silent,
      });

      const first = probe.evaluate();
      const second = probe.evaluate();
      const third = probe.evaluate();
      release();

      const reports = await Promise.all([first, second, third]);
      expect(runs).toBe(1);
      expect(reports[0]).toBe(reports[1]);
      expect(reports[1]).toBe(reports[2]);
    });

    it('starts a fresh evaluation once the previous one has settled', async () => {
      let runs = 0;
      const probe = createReadinessProbe({
        checks: () => [
          check('postgres', 'critical', () => {
            runs += 1;
            return Promise.resolve();
          }),
        ],
        timeoutMs: 100,
        cacheTtlMs: 0,
        logger: silent,
      });

      await probe.evaluate();
      await probe.evaluate();
      expect(runs).toBe(2);
    });
  });

  describe('transition logging', () => {
    it('says nothing at all while the state holds', async () => {
      // At the rates a readiness endpoint is polled, a line per evaluation is
      // tens of thousands a day saying the same thing — which is both the cost
      // and the reason nobody reads it.
      const logger = recordingLogger();
      const probe = createReadinessProbe({
        checks: () => [passing('postgres')],
        timeoutMs: 100,
        cacheTtlMs: 0,
        logger,
      });

      await probe.evaluate();
      await probe.evaluate();
      await probe.evaluate();

      expect(logger.lines).toEqual([]);
    });

    it('logs the failure, the second failure, and the recovery', async () => {
      const logger = recordingLogger();
      const registry: DependencyCheck[] = [passing('postgres'), passing('redis', 'optional')];
      const probe = createReadinessProbe({
        checks: () => registry,
        timeoutMs: 100,
        cacheTtlMs: 0,
        logger,
      });

      await probe.evaluate();
      expect(logger.lines).toEqual([]);

      registry[0] = failing('postgres', 'critical', 'ECONNREFUSED');
      await probe.evaluate();
      expect(logger.lines).toHaveLength(1);
      expect(logger.lines[0]).toContain('unready');
      expect(logger.lines[0]).toContain('postgres (critical)');
      // The reason is in the log whether or not it is in the response.
      expect(logger.lines[0]).toContain('ECONNREFUSED');

      // A second dependency failing does not change the overall status, and is
      // still the more interesting half of the incident.
      registry[1] = failing('redis', 'optional');
      await probe.evaluate();
      expect(logger.lines).toHaveLength(2);
      expect(logger.lines[1]).toContain('redis (optional)');

      registry[0] = passing('postgres');
      registry[1] = passing('redis', 'optional');
      await probe.evaluate();
      expect(logger.lines).toHaveLength(3);
      expect(logger.lines[2]).toContain('recovered');
    });

    it('does not announce a healthy first evaluation, and does announce an unhealthy one', async () => {
      const healthy = recordingLogger();
      await createReadinessProbe({
        checks: () => [passing('postgres')],
        timeoutMs: 100,
        cacheTtlMs: 0,
        logger: healthy,
      }).evaluate();
      expect(healthy.lines).toEqual([]);

      const broken = recordingLogger();
      await createReadinessProbe({
        checks: () => [failing('postgres')],
        timeoutMs: 100,
        cacheTtlMs: 0,
        logger: broken,
      }).evaluate();
      expect(broken.lines).toHaveLength(1);
    });
  });
});

describe('redactReport', () => {
  const report: ReadinessReport = {
    status: 'unready',
    checkedAt: 1_700_000_000_000,
    checks: [
      {
        name: 'postgres',
        criticality: 'critical',
        status: 'failed',
        durationMs: 12,
        error: 'Error: connect ECONNREFUSED db.internal:5432',
      },
    ],
  };

  it('drops the reason by default, keeping which check failed', () => {
    // A readiness endpoint is routinely reachable from further away than the API
    // it guards, and a `pg` error names the host, port and database.
    const [redacted] = redactReport(report, false).checks;

    expect(redacted).toEqual({
      name: 'postgres',
      criticality: 'critical',
      status: 'failed',
      durationMs: 12,
    });
    expect(redacted).not.toHaveProperty('error');
  });

  it('keeps it when the deployment has asked for it', () => {
    expect(redactReport(report, true)).toBe(report);
  });

  it('leaves the report it was given untouched', () => {
    redactReport(report, false);
    expect(report.checks[0]?.error).toContain('db.internal:5432');
  });
});
