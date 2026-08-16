import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import type { Precondition } from '@/concurrency/concurrency.types';
import {
  PreconditionMalformedError,
  PreconditionRequiredError,
} from '@/concurrency/concurrency.errors';
import type { WithPrecondition } from '@/concurrency/precondition';
import { requireIfMatch } from '@/concurrency/precondition';
import { compose } from '@/lib/pipeline';
import { errorMiddleware } from '@/middleware/error.middleware';

/**
 * The step behind a real pipeline and the real error middleware, because what
 * it is for is the response a client gets — a `req` object literal would
 * happily accept a `get` that Express's own `Request` implements differently
 * (case-insensitively, for one).
 */
function appWith(): express.Application {
  const app = express();
  app.put(
    '/things/:id',
    compose()
      .use(requireIfMatch)
      .handle(async (req: WithPrecondition<Request>) => req.precondition),
  );
  app.use(errorMiddleware);
  return app;
}

const app = appWith();

async function preconditionFor(header: string): Promise<Precondition> {
  const res = await request(app).put('/things/1').set('If-Match', header);
  expect(res.status).toBe(200);
  return res.body.data as Precondition;
}

describe('requireIfMatch', () => {
  it('puts the parsed precondition on the request', async () => {
    await expect(preconditionFor('"7"')).resolves.toEqual({ kind: 'versions', versions: [7] });
    await expect(preconditionFor('*')).resolves.toEqual({ kind: 'any' });
  });

  it('reads the header case-insensitively, as HTTP requires', async () => {
    const res = await request(app).put('/things/1').set('if-match', '"7"');
    expect(res.status).toBe(200);
  });

  it('answers 428 when the header is absent', async () => {
    const res = await request(app).put('/things/1');

    // 428, not 400: the request is well-formed, and 428 is the status a client
    // library keys on to go and fetch a validator.
    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
  });

  it('answers 428 for an empty header rather than treating it as a wildcard', async () => {
    const res = await request(app).put('/things/1').set('If-Match', '');

    expect(res.status).toBe(428);
  });

  it('answers 400 for a header that is not an entity-tag list', async () => {
    const res = await request(app).put('/things/1').set('If-Match', 'seven');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRECONDITION_MALFORMED');
    expect(res.body.error.message).toContain('If-Match');
  });

  it('answers 400 for a weak tag, which a 412 would turn into a retry loop', async () => {
    const res = await request(app).put('/things/1').set('If-Match', 'W/"7"');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRECONDITION_MALFORMED');
  });

  it('passes an unmatchable but well-formed tag through as an empty version set', async () => {
    // Not the step's business to reject: an empty set matches no row, and the
    // 412 comes from the write, where the row's actual state is known.
    await expect(preconditionFor('"not-a-version"')).resolves.toEqual({
      kind: 'versions',
      versions: [],
    });
  });

  it('returns the same request object it was given', () => {
    const req = { get: () => '"7"' } as unknown as Request;

    // Refinement, not replacement: every step after this one — and the
    // operation — must still be looking at the request Express created.
    expect(requireIfMatch(req)).toBe(req);
  });

  it('throws typed errors rather than generic ones', () => {
    const withoutHeader = { get: () => undefined } as unknown as Request;
    const withWeakTag = { get: () => 'W/"7"' } as unknown as Request;

    expect(() => requireIfMatch(withoutHeader)).toThrow(PreconditionRequiredError);
    expect(() => requireIfMatch(withWeakTag)).toThrow(PreconditionMalformedError);
  });
});
