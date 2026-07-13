import { ok, created, fail, sendOk, sendCreated, sendNoContent, sendFail } from '@/lib/response';
import type { ApiResponse } from '@/lib/response';

function makeRes() {
  const body: { statusCode: number; json: unknown; ended: boolean } = {
    statusCode: 200,
    json: undefined,
    ended: false,
  };
  const res = {
    status(code: number) {
      body.statusCode = code;
      return res;
    },
    json(data: unknown) {
      body.json = data;
      return res;
    },
    end() {
      body.ended = true;
      return res;
    },
    _body: body,
  };
  return res;
}

describe('response envelope factories', () => {
  describe('ok()', () => {
    it('sets data and nulls meta/error', () => {
      const result: ApiResponse<{ id: number }> = ok({ id: 1 });
      expect(result).toEqual({ data: { id: 1 }, meta: null, error: null });
    });

    it('includes meta when provided', () => {
      const result = ok('value', { count: 5 });
      expect(result.meta).toEqual({ count: 5 });
    });
  });

  describe('created()', () => {
    it('sets data and nulls meta/error', () => {
      const result = created({ id: 'abc' });
      expect(result).toEqual({ data: { id: 'abc' }, meta: null, error: null });
    });
  });

  describe('fail()', () => {
    it('sets error and nulls data/meta', () => {
      const result = fail('NOT_FOUND', 'Resource not found');
      expect(result).toEqual({
        data: null,
        meta: null,
        error: { code: 'NOT_FOUND', message: 'Resource not found' },
      });
    });

    it('includes issues when provided', () => {
      const issues = [{ path: ['email'], message: 'Invalid email' }];
      const result = fail('VALIDATION_ERROR', 'Validation failed', issues);
      expect(result.error?.issues).toEqual(issues);
    });

    it('omits issues key when not provided', () => {
      const result = fail('INTERNAL_ERROR', 'Oops');
      expect(result.error).not.toHaveProperty('issues');
    });
  });
});

describe('response envelope senders', () => {
  describe('sendOk()', () => {
    it('responds 200 with ok envelope', () => {
      const res = makeRes();
      sendOk(res as never, { name: 'Alice' });
      expect(res._body.statusCode).toBe(200);
      expect(res._body.json).toEqual({ data: { name: 'Alice' }, meta: null, error: null });
    });

    it('includes meta when provided', () => {
      const res = makeRes();
      sendOk(res as never, [], { page: 1 });
      expect((res._body.json as ApiResponse).meta).toEqual({ page: 1 });
    });
  });

  describe('sendCreated()', () => {
    it('responds 201 with created envelope', () => {
      const res = makeRes();
      sendCreated(res as never, { id: '1' });
      expect(res._body.statusCode).toBe(201);
      expect((res._body.json as ApiResponse).data).toEqual({ id: '1' });
    });
  });

  describe('sendNoContent()', () => {
    it('responds 204 with no body', () => {
      const res = makeRes();
      sendNoContent(res as never);
      expect(res._body.statusCode).toBe(204);
      expect(res._body.ended).toBe(true);
    });
  });

  describe('sendFail()', () => {
    it('responds with given status and fail envelope', () => {
      const res = makeRes();
      sendFail(res as never, 404, 'NOT_FOUND', 'Not found');
      expect(res._body.statusCode).toBe(404);
      expect(res._body.json).toEqual({
        data: null,
        meta: null,
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
    });

    it('includes issues in validation error responses', () => {
      const res = makeRes();
      const issues = [{ path: ['field'], message: 'Required' }];
      sendFail(res as never, 422, 'VALIDATION_ERROR', 'Validation failed', issues);
      expect((res._body.json as ApiResponse).error?.issues).toEqual(issues);
    });
  });
});
