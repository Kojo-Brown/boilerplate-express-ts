import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import type { Registry } from '@prometheus-io/client';
import {
  HTTP_REQUESTS_IN_FLIGHT,
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_SECONDS,
  createHttpMetrics,
  createMetricsRegistry,
} from '@/metrics/http-metrics';
import type { HttpMetrics } from '@/metrics/http-metrics';
import { ROUTE_UNMATCHED, createRouteLabeller } from '@/metrics/labels';
import { CLIENT_CLOSED_REQUEST, createMetricsMiddleware } from '@/metrics/metrics.middleware';

/**
 * A fresh registry per case, which is the reason `createMetricsRegistry` exists
 * rather than the library's module-level default: a counter is cumulative, so a
 * shared registry makes every assertion here depend on which tests ran first.
 */
function harness(options: { ignoredPaths?: readonly string[]; exemplars?: boolean } = {}): {
  app: express.Express;
  registry: Registry;
  metrics: HttpMetrics;
} {
  const exemplars = options.exemplars ?? false;
  const registry = createMetricsRegistry({ exemplars });
  const metrics = createHttpMetrics({ registry, exemplars });
  const middleware = createMetricsMiddleware({
    metrics,
    labeller: createRouteLabeller({ maxLabels: 50 }),
    ignoredPaths: options.ignoredPaths,
  });

  const app = express();
  app.use(middleware);

  const users = express.Router();
  users.get('/:id', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  users.post('/', (_req, res) => {
    res.status(201).end();
  });
  app.use('/v1/users', users);

  app.get('/v1/boom', (_req, res) => {
    res.status(500).json({ error: 'nope' });
  });
  app.get('/metrics', (_req, res) => {
    res.status(200).send('# scraped');
  });

  return { app, registry, metrics };
}

describe('createMetricsMiddleware', () => {
  it('counts a request under the route pattern, not the path it arrived on', async () => {
    const { app, registry } = harness();

    await request(app).get('/v1/users/42').expect(200);
    await request(app).get('/v1/users/99').expect(200);

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="/v1/users/:id",status_code="200"} 2`,
    );
    // The assertion that makes the one above worth having: two different ids
    // did not become two series.
    expect(exposition).not.toContain('/v1/users/42');
  });

  it('separates methods and status codes on the counter', async () => {
    const { app, registry } = harness();

    await request(app).get('/v1/users/1').expect(200);
    await request(app).post('/v1/users').expect(201);
    await request(app).get('/v1/boom').expect(500);

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="/v1/users/:id",status_code="200"} 1`,
    );
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="POST",route="/v1/users",status_code="201"} 1`,
    );
    // The E of RED: an error rate is this slice over the whole, which is why a
    // separate failure counter would be a second source of truth for one number.
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="/v1/boom",status_code="500"} 1`,
    );
  });

  it('observes a duration in the histogram for every counted request', async () => {
    const { app, registry } = harness();

    await request(app).get('/v1/users/1').expect(200);

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_count{method="GET",route="/v1/users/:id"} 1`,
    );
    // Seconds. A request served from memory is well under the 5ms floor, so the
    // smallest bucket already holds it — the assertion that would fail if this
    // were recording milliseconds.
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_bucket{le="0.005",method="GET",route="/v1/users/:id"} 1`,
    );
  });

  it('returns the in-flight gauge to zero after a request finishes', async () => {
    const { app, registry } = harness();

    await request(app).get('/v1/users/1').expect(200);

    await expect(registry.metrics()).resolves.toContain(
      `${HTTP_REQUESTS_IN_FLIGHT}{method="GET"} 0`,
    );
  });

  it('holds the gauge above zero while a request is still being served', async () => {
    const { registry, metrics } = harness();
    const middleware = createMetricsMiddleware({
      metrics,
      labeller: createRouteLabeller({ maxLabels: 50 }),
    });

    const app = express();
    app.use(middleware);

    let release = (): void => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observedDuringRequest = '';

    app.get('/slow', (_req, res) => {
      void (async () => {
        observedDuringRequest = await registry.metrics();
        release();
        res.status(200).end();
      })();
    });

    // `.then()` and not just `.expect()`: supertest does not dispatch until the
    // Test is awaited, so holding an un-awaited handle here would wait forever
    // for a request that was never sent.
    const pending = request(app)
      .get('/slow')
      .expect(200)
      .then(() => undefined);
    await inFlight;
    await pending;

    // Read from inside the handler: the gauge is what separates "slow" from
    // "stuck", and a stall is precisely the state in which nothing finishes and
    // so the rate and the histogram both go quiet.
    expect(observedDuringRequest).toContain(`${HTTP_REQUESTS_IN_FLIGHT}{method="GET"} 1`);
  });

  it('folds every unrouted request into one label', async () => {
    const { app, registry } = harness();

    await request(app).get('/wp-login.php').expect(404);
    await request(app).get('/.env').expect(404);

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="${ROUTE_UNMATCHED}",status_code="404"} 2`,
    );
    expect(exposition).not.toContain('wp-login');
  });

  it('skips the paths it was told to skip', async () => {
    const { app, registry } = harness({ ignoredPaths: ['/metrics'] });

    await request(app).get('/metrics').expect(200);
    await request(app).get('/v1/users/1').expect(200);

    const exposition = await registry.metrics();
    expect(exposition).not.toContain('route="/metrics"');
    expect(exposition).toContain('route="/v1/users/:id"');
  });

  it('counts a query string under the same route as the bare path', async () => {
    const { app, registry } = harness({ ignoredPaths: ['/metrics'] });

    // `req.path` and not `req.url`, so the skip list cannot be walked around by
    // appending `?x=1` — and so a route is not two series for the same endpoint.
    await request(app).get('/metrics?collect=all').expect(200);
    await request(app).get('/v1/users/1?include=posts').expect(200);

    const exposition = await registry.metrics();
    expect(exposition).not.toContain('route="/metrics"');
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="/v1/users/:id",status_code="200"} 1`,
    );
  });

  /**
   * A client that hangs up gets `close` and never `finish`. Two things have to
   * happen and neither does for free: the gauge has to come back down, or it
   * drifts up forever and reads as a service slowly wedging; and the request
   * has to be recorded as abandoned rather than as the `200` that `statusCode`
   * still defaults to.
   *
   * Driven against the response object directly rather than through a socket —
   * supertest cannot abort mid-flight, and what is under test is which listener
   * the middleware trusted, not Node's socket teardown.
   */
  it('records an abandoned request as 499 and releases the gauge', async () => {
    const { registry, metrics } = harness();
    const middleware = createMetricsMiddleware({
      metrics,
      labeller: createRouteLabeller({ maxLabels: 50 }),
    });

    // No `route`: the router never dispatched, because the client left first.
    const req = { method: 'GET', path: '/v1/users/1', originalUrl: '/v1/users/1' };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      // Nothing was ever written, which is the discriminator the middleware
      // reads: `finish` implies `writableEnded`, and a bare `close` does not.
      writableEnded: false,
    });

    middleware(
      req as unknown as Parameters<typeof middleware>[0],
      res as unknown as Parameters<typeof middleware>[1],
      () => {},
    );

    res.emit('close');

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="${ROUTE_UNMATCHED}",status_code="${CLIENT_CLOSED_REQUEST}"} 1`,
    );
    expect(exposition).toContain(`${HTTP_REQUESTS_IN_FLIGHT}{method="GET"} 0`);
  });

  it('records a request once when both finish and close fire', async () => {
    const { registry, metrics } = harness();
    const middleware = createMetricsMiddleware({
      metrics,
      labeller: createRouteLabeller({ maxLabels: 50 }),
    });

    const req = { method: 'GET', path: '/x', originalUrl: '/x', route: { path: '/x' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 204, writableEnded: true });

    middleware(
      req as unknown as Parameters<typeof middleware>[0],
      res as unknown as Parameters<typeof middleware>[1],
      () => {},
    );

    // The ordinary sequence for a served request: both events, one observation.
    // Double-counting here would inflate the rate of every endpoint by exactly
    // 2, which is the kind of error that looks like traffic.
    res.emit('finish');
    res.emit('close');

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="/x",status_code="204"} 1`,
    );
    expect(exposition).toContain(`${HTTP_REQUESTS_IN_FLIGHT}{method="GET"} 0`);
  });

  it('calls next so the request still reaches its handler', async () => {
    const { app } = harness();
    await request(app).get('/v1/users/1').expect(200, { ok: true });
  });

  it('observes without an exemplar when there is no sampled trace', async () => {
    // Exemplars on and tracing off is the combination `env.ts` refuses at boot;
    // exercised here because the middleware has to survive it anyway — every
    // unsampled request takes this path once a sampler is below 1.
    const { app, registry } = harness({ exemplars: true });

    await request(app).get('/v1/users/1').expect(200);

    const exposition = await registry.metrics();
    expect(exposition).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_count{method="GET",route="/v1/users/:id"} 1`,
    );
    expect(exposition).not.toContain('trace_id');
  });
});
