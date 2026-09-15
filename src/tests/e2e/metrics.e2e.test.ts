import request from 'supertest';
import { createApp } from '@/app';
import { appMetrics } from '@/metrics';
import {
  HTTP_REQUESTS_IN_FLIGHT,
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_SECONDS,
} from '@/metrics/http-metrics';
import { ROUTE_UNMATCHED } from '@/metrics/labels';
import { UNTRACED_PATHS } from '@/observability';

// env vars are set in jest.setup.ts

/**
 * The metrics endpoint against the real application, which is the only place
 * three assumptions the unit suites make can actually be checked:
 *
 * - that `req.route` and `req.baseUrl` on a request that went through the real
 *   router produce the label shape `labels.test.ts` fakes;
 * - that the middleware's position in `createApp` puts it ahead of everything
 *   and that the exposition is reachable without a session or a token;
 * - that `/v1/health` and the exposition itself are not counted, which is a
 *   claim about `app.ts` rather than about the middleware.
 *
 * `appMetrics` is a process singleton and its counters are cumulative, so every
 * case reads a *delta* rather than an absolute. Resetting between cases would
 * work too and would hide the thing worth knowing: the registry outlives the
 * app object, which is what makes a scrape after a reload comparable to one
 * before it.
 */

const app = createApp();

async function scrape(): Promise<string> {
  const response = await request(app).get('/metrics').expect(200);
  return response.text;
}

function counterValue(exposition: string, series: string): number {
  const line = exposition
    .split('\n')
    .find((candidate) => candidate.startsWith(`${HTTP_REQUESTS_TOTAL}{${series}}`));
  if (line === undefined) return 0;

  const value = line.slice(line.lastIndexOf(' ') + 1);
  return Number(value);
}

describe('GET /metrics', () => {
  it('serves the Prometheus exposition unauthenticated', async () => {
    const response = await request(app).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain(`# TYPE ${HTTP_REQUESTS_TOTAL} counter`);
    expect(response.text).toContain(`# TYPE ${HTTP_REQUEST_DURATION_SECONDS} histogram`);
    expect(response.text).toContain(`# TYPE ${HTTP_REQUESTS_IN_FLIGHT} gauge`);
  });

  it('labels a real request by the pattern the real router matched', async () => {
    const series = 'method="GET",route="/v1/users/:id",status_code="401"';
    const before = counterValue(await scrape(), series);

    // Unauthenticated on purpose: what is under test is the label, and a 401
    // reaches the route — so `req.route` is set — without this suite needing a
    // database or a token.
    await request(app).get('/v1/users/00000000-0000-4000-8000-000000000000').expect(401);

    const after = await scrape();
    expect(counterValue(after, series)).toBe(before + 1);
    // The id is nowhere in the exposition, which is the property that keeps the
    // series count bounded by the number of routes rather than by traffic.
    expect(after).not.toContain('00000000-0000-4000-8000-000000000000');
  });

  it('folds a request that matched no route into one label', async () => {
    const series = `method="GET",route="${ROUTE_UNMATCHED}",status_code="404"`;
    const before = counterValue(await scrape(), series);

    await request(app).get('/definitely-not-a-route').expect(404);
    await request(app).get('/.env').expect(404);

    expect(counterValue(await scrape(), series)).toBe(before + 2);
  });

  it('does not measure the exposition or the health probe', async () => {
    await request(app).get('/v1/health').expect(200);
    const exposition = await scrape();

    expect(exposition).not.toContain('route="/metrics"');
    expect(exposition).not.toContain('route="/v1/health"');
  });

  it('leaves the exposition out of tracing too', () => {
    // `app.ts` and `tracing.ts` make the same exclusion for different reasons,
    // so they are two lists — this is the assertion that keeps the second one
    // from being forgotten when `METRICS_PATH` moves.
    expect(UNTRACED_PATHS).toContain('/metrics');
  });

  it('returns the in-flight gauge to zero once the app is idle', async () => {
    // Read after the requests above have all completed. A gauge that does not
    // come back down is the failure mode of listening for `finish` alone, and
    // it is invisible in any assertion that only looks at counters.
    expect(await scrape()).toContain(`${HTTP_REQUESTS_IN_FLIGHT}{method="GET"} 0`);
  });

  it('records the route label through the same labeller the app was built with', async () => {
    // The labeller is shared with `appMetrics`, so the patterns it admitted are
    // the ones on the wire. Non-zero after the cases above, and far below the
    // cap, which is the only thing worth asserting about a number that depends
    // on which routes this suite happened to touch.
    expect(appMetrics.labeller.size).toBeGreaterThan(0);
  });
});
