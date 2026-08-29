import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { sendByteRange } from '@/http/byte-range';
import type { ByteSource } from '@/http/byte-range';

/**
 * The HTTP contract, driven against a real server over a real socket.
 *
 * A unit test with a fake `Response` would be faster and would prove less than
 * it looks: half of what this module is responsible for is framing —
 * `Content-Length` agreeing with the bytes that follow, a 304 and a HEAD
 * carrying no body at all — and framing is exactly what a mock cannot get
 * wrong. Everything below asserts against what came off the wire.
 */

const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const ETAG = `"${createHash('sha256').update(BODY).digest('hex')}"`;
const LAST_MODIFIED = new Date('2026-03-04T05:06:07.000Z');
const LAST_MODIFIED_HTTP = 'Wed, 04 Mar 2026 05:06:07 GMT';

interface Harness {
  app: Express;
  /** Intervals `open` was asked for, in order — so "did not read" is testable. */
  opened: { start: number; end: number }[];
}

function harness(overrides: Partial<ByteSource> = {}, body: Buffer = BODY): Harness {
  const opened: Harness['opened'] = [];

  const source: ByteSource = {
    size: body.length,
    etag: ETAG,
    contentType: 'text/plain',
    lastModified: LAST_MODIFIED,
    open: (range) => {
      opened.push({ start: range.start, end: range.end });
      return Promise.resolve(Readable.from([body.subarray(range.start, range.end + 1)]));
    },
    ...overrides,
  };

  const app = express();
  app.get('/thing', (req, res, next) => {
    sendByteRange(req, res, source).catch(next);
  });

  return { app, opened };
}

describe('a plain GET', () => {
  it('sends the whole representation with the validators and Accept-Ranges', async () => {
    const { app } = harness();
    const res = await request(app).get('/thing');

    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['etag']).toBe(ETAG);
    expect(res.headers['last-modified']).toBe(LAST_MODIFIED_HTTP);
    expect(res.headers['content-length']).toBe(String(BODY.length));
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.text).toBe(BODY.toString());
  });

  it('carries a conservative Cache-Control by default', () => {
    return request(harness().app)
      .get('/thing')
      .expect('Cache-Control', 'private, no-cache');
  });

  it('uses the Cache-Control the caller asked for', async () => {
    const app = express();

    app.get('/thing', (req, res, next) => {
      sendByteRange(
        req,
        res,
        {
          size: BODY.length,
          etag: ETAG,
          contentType: 'text/plain',
          open: (range) => Promise.resolve(Readable.from([BODY.subarray(range.start, range.end + 1)])),
        },
        { cacheControl: 'private, max-age=31536000, immutable' },
      ).catch(next);
    });

    await request(app).get('/thing').expect('Cache-Control', 'private, max-age=31536000, immutable');
  });
});

describe('Range', () => {
  it('answers a closed interval with 206 and exactly those bytes', async () => {
    const { app, opened } = harness();
    const res = await request(app).get('/thing').set('Range', 'bytes=0-9');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-9/${BODY.length}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.text).toBe('0123456789');
    expect(opened).toEqual([{ start: 0, end: 9 }]);
  });

  it('answers an open-ended interval with the rest of the representation', async () => {
    const { app } = harness();
    const res = await request(app).get('/thing').set('Range', 'bytes=26-');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 26-35/${BODY.length}`);
    expect(res.text).toBe('qrstuvwxyz');
  });

  it('answers a suffix range from the end', async () => {
    const { app } = harness();
    const res = await request(app).get('/thing').set('Range', 'bytes=-6');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 30-35/${BODY.length}`);
    expect(res.text).toBe('uvwxyz');
  });

  it('answers a single byte', async () => {
    const { app } = harness();
    const res = await request(app).get('/thing').set('Range', 'bytes=5-5');

    expect(res.status).toBe(206);
    expect(res.headers['content-length']).toBe('1');
    expect(res.text).toBe('5');
  });

  it('refuses an unsatisfiable range with 416 and the real length', async () => {
    const { app, opened } = harness();
    const res = await request(app).get('/thing').set('Range', `bytes=${BODY.length}-`);

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${BODY.length}`);
    expect(res.body.error.code).toBe('RANGE_NOT_SATISFIABLE');
    // Nothing was read: a 416 is decided entirely from the size.
    expect(opened).toEqual([]);
  });

  it('ignores a malformed Range and sends everything', async () => {
    const { app } = harness();
    const res = await request(app).get('/thing').set('Range', 'bytes=nonsense');

    expect(res.status).toBe(200);
    expect(res.text).toBe(BODY.toString());
  });

  it('ignores an unknown range unit', async () => {
    const { app } = harness();
    await request(app).get('/thing').set('Range', 'lines=0-5').expect(200);
  });

  it('ignores a multi-range request rather than answering one part of it', async () => {
    const { app } = harness();
    const res = await request(app).get('/thing').set('Range', 'bytes=0-4, 10-14');

    expect(res.status).toBe(200);
    expect(res.text).toBe(BODY.toString());
  });
});

describe('If-Range', () => {
  it('applies the range when the tag still matches', async () => {
    const { app } = harness();
    await request(app)
      .get('/thing')
      .set('If-Range', ETAG)
      .set('Range', 'bytes=0-3')
      .expect(206);
  });

  it('sends the whole representation when the tag has moved on', async () => {
    const { app } = harness();
    const res = await request(app)
      .get('/thing')
      .set('If-Range', '"stale"')
      .set('Range', 'bytes=0-3');

    // 200, not 412: the client said "resume if it is unchanged, otherwise
    // start over", and this is the second half of that sentence.
    expect(res.status).toBe(200);
    expect(res.text).toBe(BODY.toString());
  });

  it('applies the range for a date equal to Last-Modified', async () => {
    const { app } = harness();
    await request(app)
      .get('/thing')
      .set('If-Range', LAST_MODIFIED_HTTP)
      .set('Range', 'bytes=0-3')
      .expect(206);
  });
});

describe('conditional GET', () => {
  it('answers 304 with no body when If-None-Match matches', async () => {
    const { app, opened } = harness();
    const res = await request(app).get('/thing').set('If-None-Match', ETAG);

    expect(res.status).toBe(304);
    expect(res.text).toBeFalsy();
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['content-type']).toBeUndefined();
    // The validators still go out — a cache needs them to keep its entry fresh.
    expect(res.headers['etag']).toBe(ETAG);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(opened).toEqual([]);
  });

  it('answers 304 for If-Modified-Since when nothing has changed', async () => {
    const { app } = harness();
    await request(app).get('/thing').set('If-Modified-Since', LAST_MODIFIED_HTTP).expect(304);
  });

  it('answers 304 rather than 206 when a request carries both a match and a Range', async () => {
    // Precedence: the conditional is evaluated first, and a matching one ends
    // the request. A 206 here would send bytes to a client that already has
    // them and has just said so.
    const { app, opened } = harness();
    await request(app)
      .get('/thing')
      .set('If-None-Match', ETAG)
      .set('Range', 'bytes=0-3')
      .expect(304);
    expect(opened).toEqual([]);
  });

  it('proceeds when the tag no longer matches', async () => {
    const { app } = harness();
    await request(app).get('/thing').set('If-None-Match', '"stale"').expect(200);
  });
});

describe('HEAD', () => {
  it('returns the headers a GET would, with no body and no read', async () => {
    const { app, opened } = harness();
    const res = await request(app).head('/thing');

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(BODY.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.text).toBeFalsy();
    expect(opened).toEqual([]);
  });

  it('previews a range, so a client can size a partial transfer before starting it', async () => {
    const { app, opened } = harness();
    const res = await request(app).head('/thing').set('Range', 'bytes=10-19');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${BODY.length}`);
    expect(res.headers['content-length']).toBe('10');
    expect(opened).toEqual([]);
  });
});

describe('a zero-byte representation', () => {
  const empty = Buffer.alloc(0);

  it('is served as an empty 200 without opening it', async () => {
    const { app, opened } = harness({}, empty);
    const res = await request(app).get('/thing');

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('0');
    expect(opened).toEqual([]);
  });

  it('refuses any range against it', async () => {
    const { app } = harness({}, empty);
    const res = await request(app).get('/thing').set('Range', 'bytes=0-');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */0');
  });
});

describe('failures', () => {
  it('propagates an open() failure while the head is still unwritten', async () => {
    const app = express();
    app.get('/thing', (req, res, next) => {
      sendByteRange(req, res, {
        size: BODY.length,
        etag: ETAG,
        contentType: 'text/plain',
        open: () => Promise.reject(new Error('backend is down')),
      }).catch(next);
    });
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(503).json({ code: 'STORAGE_UNAVAILABLE' });
    });

    const res = await request(app).get('/thing');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
    // And the head this response *would* have had is not left on the error:
    // the source is opened before `Content-Type` and `Content-Length` are
    // committed, so a JSON error is not framed as a truncated `text/plain`.
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-range']).toBeUndefined();
  });

  it('destroys the connection when the source fails after the body has started', async () => {
    // There is no way to turn a half-sent 200 into a 500, and `next(err)` would
    // have the error handler write a second set of headers onto a response that
    // already has some. A truncated body on a killed connection is the only
    // honest signal left, and the declared `Content-Length` is what lets the
    // client detect it.
    const app = express();
    app.get('/thing', (req, res, next) => {
      sendByteRange(req, res, {
        size: BODY.length,
        etag: ETAG,
        contentType: 'text/plain',
        open: () =>
          Promise.resolve(
            new Readable({
              read(): void {
                this.push(BODY.subarray(0, 4));
                this.destroy(new Error('read failed mid-object'));
              },
            }),
          ),
      }).catch(next);
    });

    await expect(request(app).get('/thing')).rejects.toThrow();
  });
});
