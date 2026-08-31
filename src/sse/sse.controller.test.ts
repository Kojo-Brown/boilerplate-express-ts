import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@/lib/errors';
import { createEventStreamHandler } from '@/sse/sse.controller';
import type { SseHub } from '@/sse/hub';

interface HubStub extends SseHub {
  readonly attached: (string | undefined)[];
}

function hubStub(hasCapacity: boolean): HubStub {
  const attached: (string | undefined)[] = [];
  return {
    attached,
    connectionCount: hasCapacity ? 0 : 3,
    maxConnections: 3,
    streamId: 'run',
    hasCapacity: () => hasCapacity,
    publish: () => ({ id: 'run:1', event: 'x', data: '{}' }),
    attach: (_connection, lastEventId) => void attached.push(lastEventId),
    closeAll: () => undefined,
  };
}

function responseStub(): { res: Response; written: string[] } {
  const written: string[] = [];
  const res = {
    statusCode: 0,
    setHeader: () => res,
    flushHeaders: () => undefined,
    write: (chunk: string) => void written.push(chunk),
    writableLength: 0,
    end: () => undefined,
    destroy: () => undefined,
    on: () => res,
  } as unknown as Response;

  return { res, written };
}

function requestStub(headers: Record<string, string> = {}): Request {
  return {
    get: (name: string): string | undefined => headers[name.toLowerCase()],
    query: {},
    socket: { setTimeout: () => undefined, setNoDelay: () => undefined },
  } as unknown as Request;
}

describe('createEventStreamHandler', () => {
  it('opens a stream and hands the hub the cursor the client arrived with', () => {
    const hub = hubStub(true);
    const { res, written } = responseStub();
    const next = jest.fn();

    createEventStreamHandler(hub)(
      requestStub({ 'last-event-id': 'run:7' }),
      res,
      next as unknown as NextFunction,
    );

    expect(hub.attached).toEqual(['run:7']);
    expect(res.statusCode).toBe(200);
    expect(written[0]).toMatch(/^retry: \d+\n\n$/);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses at the ceiling, before the response is committed', () => {
    // The check has to happen here and not in `attach`: once
    // `openSseConnection` has flushed the headers there is no status left to
    // send, and closing a stream that already answered 200 is indistinguishable
    // to the client from a network fault.
    const hub = hubStub(false);
    const { res, written } = responseStub();
    const next = jest.fn();

    createEventStreamHandler(hub)(requestStub(), res, next as unknown as NextFunction);

    expect(hub.attached).toEqual([]);
    expect(written).toEqual([]);
    expect(res.statusCode).toBe(0);

    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('SSE_CAPACITY_EXHAUSTED');
    // The part of a 503 a client can act on. Without it the status is a dead end.
    expect(error.headers?.['Retry-After']).toMatch(/^\d+$/);
    expect(error.message).toContain('3');
  });

  it('starts a fresh stream when no cursor was presented', () => {
    const hub = hubStub(true);
    createEventStreamHandler(hub)(
      requestStub(),
      responseStub().res,
      jest.fn() as unknown as NextFunction,
    );

    expect(hub.attached).toEqual([undefined]);
  });

  it('forwards a failure to the error middleware rather than answering inline', () => {
    const hub = hubStub(true);
    hub.attach = (): never => {
      throw new Error('hub exploded');
    };
    const next = jest.fn();

    createEventStreamHandler(hub)(
      requestStub(),
      responseStub().res,
      next as unknown as NextFunction,
    );

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
