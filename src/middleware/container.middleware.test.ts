import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { createContainer, createToken } from '@/lib/container';
import type { Container } from '@/lib/container';
import { DisposedError } from '@/lib/container/container.errors';
import { AppError } from '@/lib/errors';
import { REQUEST } from '@/container/tokens';
import { createContainerMiddleware, scopeOf } from '@/middleware/container.middleware';

const DISPOSABLE = createToken<{ open: boolean }>('Disposable');

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as unknown as Request;
}

/**
 * A `Response` is only ever used here as an event emitter, so this is the whole
 * surface the middleware touches — and `close` can be fired on it directly,
 * which is what the disposal assertions need.
 */
function mockRes(): Response & EventEmitter {
  return new EventEmitter() as unknown as Response & EventEmitter;
}

function testContainer(): Container {
  return createContainer({ name: 'mw-test', onDisposeError: () => {} }).registerSeed(REQUEST);
}

describe('containerMiddleware', () => {
  it('opens a scope, seeds the request into it, and continues', () => {
    const middleware = createContainerMiddleware(testContainer());
    const req = mockReq();
    const next = jest.fn() as unknown as NextFunction;

    middleware(req, mockRes(), next);

    expect(req.scope).toBeDefined();
    expect(req.scope?.resolve(REQUEST)).toBe(req);
    expect(next).toHaveBeenCalledWith();
  });

  it('names the scope after the correlation id', () => {
    const middleware = createContainerMiddleware(testContainer());
    const req = mockReq({ headers: { 'x-correlation-id': 'corr-9' } });

    middleware(req, mockRes(), jest.fn() as unknown as NextFunction);

    expect(req.scope?.name).toBe('request:corr-9');
  });

  it('gives every request its own scope', () => {
    const middleware = createContainerMiddleware(testContainer());
    const first = mockReq();
    const second = mockReq();

    middleware(first, mockRes(), jest.fn() as unknown as NextFunction);
    middleware(second, mockRes(), jest.fn() as unknown as NextFunction);

    expect(first.scope).not.toBe(second.scope);
  });

  it('disposes the scope when the response closes', async () => {
    const container = testContainer().registerScoped(
      DISPOSABLE,
      () => ({ open: true }),
      { dispose: (instance) => void (instance.open = false) },
    );
    const middleware = createContainerMiddleware(container);
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, jest.fn() as unknown as NextFunction);
    const resource = req.scope?.resolve(DISPOSABLE);

    res.emit('close');
    await req.scope?.dispose();

    expect(resource?.open).toBe(false);
    expect(req.scope?.disposed).toBe(true);
    expect(() => req.scope?.resolve(REQUEST)).toThrow(DisposedError);
  });

  it('disposes on an aborted response too, not only a completed one', async () => {
    // `finish` would not fire for a client that hung up mid-request, and the
    // scope — plus anything it had opened — would outlive the request.
    const dispose = jest.fn();
    const container = testContainer().registerScoped(DISPOSABLE, () => ({ open: true }), {
      dispose,
    });
    const middleware = createContainerMiddleware(container);
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, jest.fn() as unknown as NextFunction);
    req.scope?.resolve(DISPOSABLE);

    // No `finish` — straight to the socket closing.
    res.emit('close');
    await req.scope?.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('survives a disposer that rejects without an unhandled rejection', async () => {
    const onDisposeError = jest.fn();
    const container = createContainer({ name: 'mw-test', onDisposeError })
      .registerSeed(REQUEST)
      .registerScoped(DISPOSABLE, () => ({ open: true }), {
        dispose: () => Promise.reject(new Error('close failed')),
      });
    const middleware = createContainerMiddleware(container);
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, jest.fn() as unknown as NextFunction);
    req.scope?.resolve(DISPOSABLE);

    res.emit('close');
    await expect(req.scope?.dispose()).resolves.toBeUndefined();
    expect(onDisposeError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
  });
});

describe('scopeOf', () => {
  it('returns the scope the middleware attached', () => {
    const middleware = createContainerMiddleware(testContainer());
    const req = mockReq();

    middleware(req, mockRes(), jest.fn() as unknown as NextFunction);

    expect(scopeOf(req)).toBe(req.scope);
  });

  it('throws a 500 when the middleware never ran', () => {
    expect(() => scopeOf(mockReq())).toThrow(AppError);

    try {
      scopeOf(mockReq());
    } catch (error) {
      expect((error as AppError).statusCode).toBe(500);
      expect((error as AppError).code).toBe('CONTAINER_SCOPE_MISSING');
    }
  });
});
