import type { NextFunction, Request, Response } from 'express';
import { createLifecycle } from '@/shutdown/lifecycle';
import { ServerShuttingDownError } from '@/shutdown/shutdown.errors';
import { shutdownGuard } from '@/shutdown/shutdown.middleware';

function call(middleware: ReturnType<typeof shutdownGuard>): jest.Mock {
  const next = jest.fn();
  middleware({} as Request, {} as Response, next as unknown as NextFunction);
  return next;
}

describe('shutdownGuard', () => {
  it('passes a request through while accepting', () => {
    const lifecycle = createLifecycle();

    expect(call(shutdownGuard({ lifecycle }))).toHaveBeenCalledWith();
  });

  it('still passes requests through during the drain window', () => {
    const lifecycle = createLifecycle();
    const middleware = shutdownGuard({ lifecycle });

    lifecycle.beginDraining();

    // The balancer is being told to stop by the readiness answer. Refusing here
    // would fail traffic it is still routing in good faith, which is the damage
    // the drain window exists to prevent.
    expect(call(middleware)).toHaveBeenCalledWith();
  });

  it('refuses a request that arrives after the listener has closed', () => {
    const lifecycle = createLifecycle();
    const middleware = shutdownGuard({ lifecycle });

    lifecycle.beginDraining();
    lifecycle.beginClosing();

    const next = call(middleware);
    const error: unknown = next.mock.calls[0]?.[0];

    expect(error).toBeInstanceOf(ServerShuttingDownError);
  });

  it('refuses once closed', () => {
    const lifecycle = createLifecycle();
    const middleware = shutdownGuard({ lifecycle });

    lifecycle.markClosed();

    expect(call(middleware).mock.calls[0]?.[0]).toBeInstanceOf(ServerShuttingDownError);
  });

  it('carries Retry-After and Connection: close on the refusal', () => {
    const lifecycle = createLifecycle();
    const middleware = shutdownGuard({ lifecycle, retryAfterSeconds: 12 });
    lifecycle.beginClosing();

    const error = call(middleware).mock.calls[0]?.[0] as ServerShuttingDownError;

    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('SERVER_SHUTTING_DOWN');
    expect(error.headers).toEqual({ 'Retry-After': '12', Connection: 'close' });
  });

  it('never advertises Retry-After: 0, which would aim the retry straight back', () => {
    const lifecycle = createLifecycle();
    const middleware = shutdownGuard({ lifecycle, retryAfterSeconds: 0 });
    lifecycle.beginClosing();

    const error = call(middleware).mock.calls[0]?.[0] as ServerShuttingDownError;

    expect(error.headers?.['Retry-After']).toBe('1');
  });
});
