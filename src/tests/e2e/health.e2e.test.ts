import request from 'supertest';
import { createApp } from '@/app';
import { clearHealthChecks, registerHealthCheck } from '@/health';
import type { DependencyCheck } from '@/health';

/**
 * The composition, through the real application object.
 *
 * What the router's own suite cannot show: that `createApp()` mounts the probes
 * at the paths a kubelet will be configured with, that they are wired to the
 * process-wide registry rather than to a list of their own, and that the
 * pre-split alias still resolves.
 *
 * The state is set up once and never changes during the file, deliberately: the
 * app's probe is the real singleton, with the real report cache, and a test
 * that flipped a dependency mid-file would be asserting against whichever side
 * of a one-second TTL it happened to land on. Every transition is covered in
 * `readiness.test.ts`, against a probe with an injected clock.
 */
const check = (name: string, criticality: DependencyCheck['criticality'], fails: boolean): DependencyCheck => ({
  name,
  criticality,
  run: () => (fails ? Promise.reject(new Error('mock-dependency-unreachable')) : Promise.resolve()),
});

describe('health probes through the app', () => {
  const app = createApp();

  beforeAll(() => {
    registerHealthCheck(check('postgres', 'critical', false));
    registerHealthCheck(check('redis', 'optional', true));
  });

  afterAll(() => {
    clearHealthChecks();
  });

  it('serves liveness at the path a kubelet is pointed at', async () => {
    const res = await request(app).get('/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', version: 'v1', state: 'accepting' });
    expect(res.body.data.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('serves readiness over the checks the process registered', async () => {
    const res = await request(app).get('/v1/health/ready');

    // 200 and `degraded`: the optional dependency is down, and shedding traffic
    // for a dependency every replica shares would empty the load balancer for a
    // fault that moving the request cannot route around.
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.checks.map((entry: { name: string }) => entry.name)).toEqual([
      'postgres',
      'redis',
    ]);
  });

  it('withholds the failure reason from the response by default', async () => {
    const res = await request(app).get('/v1/health/ready');

    expect(JSON.stringify(res.body)).not.toContain('mock-dependency-unreachable');
  });

  it('still answers on the pre-split path', async () => {
    const res = await request(app).get('/v1/health');

    expect(res.status).toBe(200);
    // The shape a balancer configured before the split is reading.
    expect(res.body.data).toMatchObject({ status: 'degraded', version: 'v1' });
  });

  it('does not answer to a path that merely starts the same way', async () => {
    // The `/v1/health` exclusions elsewhere are prefix matches now, and this is
    // the route they must not swallow.
    expect((await request(app).get('/v1/healthcheck-admin')).status).toBe(404);
  });
});
