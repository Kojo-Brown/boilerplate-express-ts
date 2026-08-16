import type { NextFunction, Request, Response } from 'express';
import { errorMiddleware } from '@/middleware/error.middleware';
import { AppError, ValidationError } from '@/lib/errors';
import { registerErrorTranslator } from '@/lib/error-translators';

function makeRes(): Response {
  const res = {} as Response;
  const json = jest.fn().mockReturnValue(res);
  const status = jest.fn().mockReturnValue(res);
  const end = jest.fn().mockReturnValue(res);
  const setHeader = jest.fn().mockReturnValue(res);
  Object.assign(res, { json, status, end, setHeader });
  return res;
}

const req = {} as Request;
const next = jest.fn() as jest.MockedFunction<NextFunction>;

describe('errorMiddleware', () => {
  it('sends an AppError with its own status and code', () => {
    const res = makeRes();
    errorMiddleware(new AppError(403, 'Forbidden', 'FORBIDDEN'), req, res, next);

    expect(res.status as jest.Mock).toHaveBeenCalledWith(403);
    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      data: null,
      meta: null,
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    });
  });

  it('sets the headers an error carries, before the body', () => {
    const res = makeRes();
    // `ETag` on a 412 and `Retry-After` on a 429 are the actionable half of
    // those answers. An operation has no `Response` to set them on, so the
    // error carries them and this is where they land.
    errorMiddleware(
      new AppError(412, 'Precondition failed', 'PRECONDITION_FAILED', { ETag: '"9"' }),
      req,
      res,
      next,
    );

    expect(res.setHeader as jest.Mock).toHaveBeenCalledWith('ETag', '"9"');
    // After `status`/`json` the head is already on the wire and a header is
    // silently dropped.
    const headerOrder = (res.setHeader as jest.Mock).mock.invocationCallOrder[0]!;
    const bodyOrder = (res.json as jest.Mock).mock.invocationCallOrder[0]!;
    expect(headerOrder).toBeLessThan(bodyOrder);
  });

  it('sets no headers for an error that carries none', () => {
    const res = makeRes();
    errorMiddleware(new AppError(403, 'Forbidden', 'FORBIDDEN'), req, res, next);

    expect(res.setHeader as jest.Mock).not.toHaveBeenCalled();
  });

  it('sends a ValidationError as 422 with the issues attached', () => {
    const res = makeRes();
    const issues = [{ path: ['email'], message: 'Invalid email' }];
    errorMiddleware(new ValidationError(issues as never), req, res, next);

    expect(res.status as jest.Mock).toHaveBeenCalledWith(422);
    const [payload] = (res.json as jest.Mock).mock.calls[0] as [
      { error: { code: string; issues: unknown[] } },
    ];
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.issues).toEqual(issues);
  });

  it('falls back to a 500 for an unrecognised error and logs it', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = makeRes();

    errorMiddleware(new Error('kaboom'), req, res, next);

    expect(res.status as jest.Mock).toHaveBeenCalledWith(500);
    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      data: null,
      meta: null,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not leak the internal message of an unrecognised error', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = makeRes();

    errorMiddleware(new Error('connect ECONNREFUSED 10.0.0.5:5432'), req, res, next);

    const [payload] = (res.json as jest.Mock).mock.calls[0] as [{ error: { message: string } }];
    expect(payload.error.message).toBe('An unexpected error occurred');
    consoleSpy.mockRestore();
  });

  it('handles a non-Error thrown value without logging a stack', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = makeRes();

    errorMiddleware('a bare string', req, res, next);

    expect(res.status as jest.Mock).toHaveBeenCalledWith(500);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('picks up an error family registered after the middleware was written', () => {
    class WidgetError extends Error {}
    registerErrorTranslator((err) =>
      err instanceof WidgetError
        ? { statusCode: 418, code: 'WIDGET_FAULT', message: 'The widget refused' }
        : null,
    );

    const res = makeRes();
    errorMiddleware(new WidgetError('x'), req, res, next);

    expect(res.status as jest.Mock).toHaveBeenCalledWith(418);
  });
});
