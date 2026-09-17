import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { createHealthRouter } from '@/health/health.router';
import { createReadinessProbe } from '@/health/readiness';
import type { ReadinessProbe } from '@/health/readiness';
import type { DependencyCheck } from '@/health/health.types';
import { createLifecycle } from '@/shutdown/lifecycle';
import type { Lifecycle } from '@/shutdown/lifecycle';

const silent = { log: () => {}, warn: () => {} };

const passing = (name: string, criticality: DependencyCheck['criticality']): DependencyCheck => ({
  name,
  criticality,
  run: () => Promise.resolve(),
});

const failing = (name: string, criticality: DependencyCheck['criticality']): DependencyCheck => ({
  name,
  criticality,
  run: () => Promise.reject(new Error('connect ECONNREFUSED db.internal:5432')),
});

function mount(options: {
  lifecycle?: Lifecycle;
  checks?: readonly DependencyCheck[];
  probe?: ReadinessProbe;
  exposeErrors?: boolean;
}): { app: Express; lifecycle: Lifecycle } {
  const lifecycle = options.lifecycle ?? createLifecycle();
  const probe =
    options.probe ??
    createReadinessProbe({
      checks: () => options.checks ?? [],
      timeoutMs: 100,
      cacheTtlMs: 0,
      logger: silent,
    });

  const app = express();
  app.use(
    '/v1/health',
    createHealthRouter({
      lifecycle,
      probe,
      exposeErrors: options.exposeErrors ?? false,
      retryAfterSeconds: 5,
      uptimeSeconds: () => 42,
    }),
  );

  return { app, lifecycle };
}

describe('GET /v1/health/live', () => {
  it('answers 200 with the process state', async () => {
    const { app } = mount({});
    const res = await request(app).get('/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      status: 'ok',
      version: 'v1',
      state: 'accepting',
      uptimeSeconds: 42,
    });
  });

  it('stays 200 through the whole shutdown, which is the point of splitting it', async () => {
    // A kubelet that fails liveness restarts the container — in the middle of a
    // drain, that is a `SIGKILL` for every request the drain existed to finish.
    // Readiness is what changes here; liveness must not.
    const { app, lifecycle } = mount({});

    lifecycle.beginDraining();
    const draining = await request(app).get('/v1/health/live');
    expect(draining.status).toBe(200);
    expect(draining.body.data.state).toBe('draining');

    lifecycle.beginClosing();
    const closing = await request(app).get('/v1/health/live');
    expect(closing.status).toBe(200);
    expect(closing.body.data.state).toBe('closing');

    // ...while readiness has been 503 since the first of those.
    expect((await request(app).get('/v1/health/ready')).status).toBe(503);
  });

  it('never touches a dependency, however broken', async () => {
    // The most damaging thing a health endpoint can be made to do: a liveness
    // probe wired to dependency checks restarts every replica at once when the
    // database has a bad minute — repeatedly, since restarting changes nothing
    // about the database, and the reconnect storm is in the way of recovery.
    let runs = 0;
    const counted: DependencyCheck = {
      name: 'postgres',
      criticality: 'critical',
      run: () => {
        runs += 1;
        return Promise.reject(new Error('down'));
      },
    };

    const { app } = mount({ checks: [counted] });

    expect((await request(app).get('/v1/health/live')).status).toBe(200);
    expect(runs).toBe(0);

    // Proof that the check works and that it is readiness which runs it.
    expect((await request(app).get('/v1/health/ready')).status).toBe(503);
    expect(runs).toBe(1);
  });
});

describe('GET /v1/health/ready', () => {
  it('answers 200 with an empty check list when nothing is registered', async () => {
    const { app } = mount({});
    const res = await request(app).get('/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', version: 'v1', checks: [] });
    expect(Date.parse(res.body.data.checkedAt)).not.toBeNaN();
  });

  it('reports each check with its cost', async () => {
    const { app } = mount({ checks: [passing('postgres', 'critical')] });
    const res = await request(app).get('/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual([
      { name: 'postgres', criticality: 'critical', status: 'ok', durationMs: expect.any(Number) },
    ]);
  });

  it('answers 503 with Retry-After when a critical dependency is down', async () => {
    const { app } = mount({ checks: [failing('postgres', 'critical')] });
    const res = await request(app).get('/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error.code).toBe('NOT_READY');
    // Which check failed, on the failure path too: a bare 503 tells an operator
    // only that something is wrong with a service they can see is wrong.
    expect(res.body.error.issues).toEqual([
      expect.objectContaining({ name: 'postgres', status: 'failed' }),
    ]);
  });

  it('stays 200 and says degraded when an optional dependency is down', async () => {
    // 200 so the balancer keeps routing here — Redis is down for every replica
    // and shedding traffic helps nobody — and `degraded` in the body so an alert
    // still has something unambiguous to fire on.
    const { app } = mount({
      checks: [passing('postgres', 'critical'), failing('redis', 'optional')],
    });
    const res = await request(app).get('/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.checks).toEqual([
      expect.objectContaining({ name: 'postgres', status: 'ok' }),
      expect.objectContaining({ name: 'redis', status: 'failed' }),
    ]);
  });

  it('answers 503 SERVER_DRAINING the instant the signal lands, before anything closes', async () => {
    const { app, lifecycle } = mount({ checks: [passing('postgres', 'critical')] });

    expect((await request(app).get('/v1/health/ready')).status).toBe(200);

    lifecycle.beginDraining();
    const res = await request(app).get('/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error.code).toBe('SERVER_DRAINING');
  });

  it('never serves the drain answer out of the report cache', async () => {
    // The lifecycle is read ahead of the probe for exactly this: a cached `ok`
    // from a second ago would keep the instance in the pool after the signal
    // landed, which is the one moment the answer has to change instantly.
    const lifecycle = createLifecycle();
    const probe = createReadinessProbe({
      checks: () => [passing('postgres', 'critical')],
      timeoutMs: 100,
      cacheTtlMs: 60_000,
      logger: silent,
    });
    const { app } = mount({ lifecycle, probe });

    expect((await request(app).get('/v1/health/ready')).status).toBe(200);

    lifecycle.beginDraining();
    expect((await request(app).get('/v1/health/ready')).status).toBe(503);
  });

  describe('failure detail', () => {
    it('withholds the reason by default', async () => {
      const { app } = mount({ checks: [failing('postgres', 'critical')] });
      const res = await request(app).get('/v1/health/ready');

      expect(res.body.error.issues[0]).not.toHaveProperty('error');
      expect(JSON.stringify(res.body)).not.toContain('db.internal');
    });

    it('includes it where the deployment has asked for it', async () => {
      const { app } = mount({ checks: [failing('postgres', 'critical')], exposeErrors: true });
      const res = await request(app).get('/v1/health/ready');

      expect(res.body.error.issues[0].error).toContain('db.internal:5432');
    });
  });

  it('forbids storing the answer anywhere', async () => {
    // A mesh sidecar or CDN holding a readiness response for even a few seconds
    // is a balancer routing to an instance that left, or refusing one that came
    // back. `no-store`, not `no-cache`, which permits storing it.
    const { app } = mount({});

    for (const path of ['/v1/health', '/v1/health/live', '/v1/health/ready']) {
      expect((await request(app).get(path)).headers['cache-control']).toBe('no-store');
    }
  });
});

describe('GET /v1/health (the pre-split alias)', () => {
  it('is readiness, which is what it always was', async () => {
    const { app, lifecycle } = mount({ checks: [passing('postgres', 'critical')] });

    const ready = await request(app).get('/v1/health');
    expect(ready.status).toBe(200);
    // The body shape the existing probe contract depends on.
    expect(ready.body.data).toMatchObject({ status: 'ok', version: 'v1' });

    lifecycle.beginDraining();
    const draining = await request(app).get('/v1/health');
    expect(draining.status).toBe(503);
    expect(draining.body.error.code).toBe('SERVER_DRAINING');
  });

  it('fails with the dependencies, exactly as /ready does', async () => {
    const { app } = mount({ checks: [failing('postgres', 'critical')] });
    const [alias, ready] = await Promise.all([
      request(app).get('/v1/health'),
      request(app).get('/v1/health/ready'),
    ]);

    expect(alias.status).toBe(ready.status);
    expect(alias.body.error.code).toBe(ready.body.error.code);
  });
});
