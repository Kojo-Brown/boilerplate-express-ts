import express from 'express';
import request from 'supertest';
import { Registry } from '@prometheus-io/client';
import {
  HTTP_REQUESTS_TOTAL,
  createHttpMetrics,
  createMetricsRegistry,
} from '@/metrics/http-metrics';
import { createMetricsRouter } from '@/metrics/metrics.router';

function appFor(registry: Registry): express.Express {
  const app = express();
  app.use('/metrics', createMetricsRouter(registry));
  return app;
}

describe('createMetricsRouter', () => {
  it('serves the exposition with the registry’s own content type', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    const metrics = createHttpMetrics({ registry, exemplars: false });
    metrics.requestsTotal.inc({ method: 'GET', route: '/v1/users', status_code: '200' });

    const response = await request(appFor(registry)).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain(
      `${HTTP_REQUESTS_TOTAL}{method="GET",route="/v1/users",status_code="200"} 1`,
    );
  });

  it('answers OpenMetrics when the registry is one, so the header follows the body', async () => {
    const registry = createMetricsRegistry({ exemplars: true });
    createHttpMetrics({ registry, exemplars: true });

    const response = await request(appFor(registry)).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('application/openmetrics-text');
    // OpenMetrics terminates the exposition, and a scraper that negotiated the
    // format rejects a body without it.
    expect(response.text.trimEnd().endsWith('# EOF')).toBe(true);
  });

  it('forbids caching, because a cached counter is a flat line', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    const response = await request(appFor(registry)).get('/metrics').expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers on the mount path only, not on paths beneath it', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    await request(appFor(registry)).get('/metrics/collect').expect(404);
  });

  /**
   * A failing collector has to fail the scrape. The alternative — catching and
   * answering 200 with whatever was gathered — leaves the scraper reporting a
   * healthy target producing no traffic, which looks exactly like an idle
   * service and not at all like a broken one.
   */
  it('passes a collector failure to the error handler rather than serving an empty 200', async () => {
    const registry = createMetricsRegistry({ exemplars: false });
    const boom = new Error('collector exploded');
    jest.spyOn(registry, 'metrics').mockRejectedValueOnce(boom);

    const app = appFor(registry);
    const seen: Error[] = [];
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      seen.push(error);
      res.status(500).end();
    });

    await request(app).get('/metrics').expect(500);
    expect(seen).toEqual([boom]);
  });
});
