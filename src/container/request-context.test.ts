import type { Request } from 'express';
import { createRequestContext } from '@/container/request-context';

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as unknown as Request;
}

describe('createRequestContext', () => {
  it('reads the correlation id off the request headers', () => {
    const req = mockReq({ headers: { 'x-correlation-id': 'corr-1' } });

    expect(createRequestContext(req).correlationId).toBe('corr-1');
  });

  it('leaves the correlation id undefined when the middleware did not run', () => {
    expect(createRequestContext(mockReq()).correlationId).toBeUndefined();
  });

  it('reports an anonymous caller as a null actor with no roles', () => {
    const context = createRequestContext(mockReq());

    expect(context.actorId).toBeNull();
    expect(context.roles).toEqual([]);
  });

  it('exposes the authenticated principal', () => {
    const req = mockReq({ auth: { userId: 'user-1', roles: ['admin'], type: 'access' } });
    const context = createRequestContext(req);

    expect(context.actorId).toBe('user-1');
    expect(context.roles).toEqual(['admin']);
  });

  it('sees authentication that happened after the context was created', () => {
    // The scoped instance is built at the first resolve, which may be before
    // `requireAuth` runs. A snapshot here would report every such request as
    // anonymous in the audit trail.
    const req = mockReq();
    const context = createRequestContext(req);

    expect(context.actorId).toBeNull();

    req.auth = { userId: 'user-2', roles: ['user'], type: 'access' };

    expect(context.actorId).toBe('user-2');
    expect(context.roles).toEqual(['user']);
  });
});
