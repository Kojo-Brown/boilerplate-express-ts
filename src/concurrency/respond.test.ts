import express from 'express';
import request from 'supertest';
import { sendWithETag } from '@/concurrency/respond';
import { compose } from '@/lib/pipeline';

interface Doc {
  id: string;
  title: string;
  version: number;
}

const DOC: Doc = { id: 'doc-1', title: 'A title', version: 12 };

function appReturning(doc: Doc): express.Application {
  const app = express();
  app.get('/doc', compose().handle(async () => doc, { send: sendWithETag }));
  return app;
}

describe('sendWithETag', () => {
  it('sends the row in the usual envelope with its validator in the header', async () => {
    const res = await request(appReturning(DOC)).get('/doc');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"12"');
    expect(res.body).toEqual({ data: DOC, meta: null, error: null });
  });

  it('emits a strong tag, because a weak one could never satisfy If-Match', async () => {
    const res = await request(appReturning(DOC)).get('/doc');

    expect(res.headers.etag?.startsWith('W/')).toBe(false);
  });

  it('leaves the decorators’ meta intact', async () => {
    const app = express();
    app.get(
      '/doc',
      compose().handle(
        async (_req, ctx) => {
          ctx.meta['cache'] = 'hit';
          return DOC;
        },
        { send: sendWithETag },
      ),
    );

    const res = await request(app).get('/doc');

    expect(res.body.meta).toEqual({ cache: 'hit' });
    expect(res.headers.etag).toBe('"12"');
  });
});
