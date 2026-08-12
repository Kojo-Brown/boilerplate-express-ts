import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@/lib/errors';
import type { JwtPayload } from '@/auth/auth.types';

const mockVerifyAccessToken = jest.fn<JwtPayload, [string]>();

jest.mock('@/lib/jwt', () => ({
  verifyAccessToken: (token: string): JwtPayload => mockVerifyAccessToken(token),
}));

import { authenticate, requireAuth, requireRole, requireRoles } from '@/middleware/auth.middleware';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  return {} as Response;
}

describe('requireAuth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls next with 401 AppError when Authorization header is missing', () => {
    const req = mockReq();
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('calls next with 401 AppError when Authorization header does not start with Bearer', () => {
    const req = mockReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('calls next with the error thrown by verifyAccessToken when token is invalid', () => {
    const tokenError = new AppError(401, 'Invalid or expired access token', 'TOKEN_INVALID');
    mockVerifyAccessToken.mockImplementation(() => { throw tokenError; });

    const req = mockReq({ headers: { authorization: 'Bearer bad.token.here' } });
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(tokenError);
  });

  it('attaches decoded payload to req.auth and calls next() on a valid token', () => {
    const payload: JwtPayload = { userId: 'u1', roles: ['user'], type: 'access' };
    mockVerifyAccessToken.mockReturnValue(payload);

    const req = mockReq({ headers: { authorization: 'Bearer valid.jwt.token' } });
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(req.auth).toEqual(payload);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('requireRole', () => {
  const basePayload: JwtPayload = { userId: 'u1', roles: ['user'], type: 'access' };

  it('calls next with 401 AppError when req.auth is not set', () => {
    const req = mockReq();
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('calls next with 403 AppError when user does not have the required role', () => {
    const req = mockReq();
    req.auth = { ...basePayload, roles: ['user'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('calls next() when user has the single required role', () => {
    const req = mockReq();
    req.auth = { ...basePayload, roles: ['admin'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() when user has at least one of the required roles', () => {
    const req = mockReq();
    req.auth = { ...basePayload, roles: ['moderator'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin', 'moderator', 'editor')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next with 403 when user has none of the required roles', () => {
    const req = mockReq();
    req.auth = { ...basePayload, roles: ['user'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin', 'moderator')(req, mockRes(), next);

    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(403);
  });

  it('supports multiple roles on the same user', () => {
    const req = mockReq();
    req.auth = { ...basePayload, roles: ['user', 'admin'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });
});

describe('authenticate (pipeline step)', () => {
  beforeEach(() => jest.clearAllMocks());

  const principal: JwtPayload = { userId: 'u1', roles: ['user'], type: 'access' };

  it('returns the request with the principal attached', () => {
    mockVerifyAccessToken.mockReturnValue(principal);
    const req = mockReq({ headers: { authorization: 'Bearer mock-access-token' } });

    const authenticated = authenticate(req);

    expect(authenticated).toBe(req);
    expect(authenticated.auth).toEqual(principal);
  });

  it('throws rather than calling next — the pipeline owns the error path', () => {
    const req = mockReq();

    expect(() => authenticate(req)).toThrow(AppError);
    try {
      authenticate(req);
    } catch (err) {
      expect((err as AppError).statusCode).toBe(401);
    }
  });

  it('surfaces a rejected token as the error the verifier raised', () => {
    const boom = new AppError(401, 'Token expired', 'TOKEN_EXPIRED');
    mockVerifyAccessToken.mockImplementation(() => {
      throw boom;
    });
    const req = mockReq({ headers: { authorization: 'Bearer mock-expired-token' } });

    expect(() => authenticate(req)).toThrow(boom);
  });
});

describe('requireRoles (pipeline step)', () => {
  const authenticatedReq = (roles: string[]): ReturnType<typeof authenticate> => {
    const req = mockReq();
    req.auth = { userId: 'u1', roles, type: 'access' };
    return req as ReturnType<typeof authenticate>;
  };

  it('returns the request unchanged when a role matches', () => {
    const req = authenticatedReq(['admin']);

    expect(requireRoles('admin')(req)).toBe(req);
  });

  it('accepts any one of several roles', () => {
    const req = authenticatedReq(['moderator']);

    expect(requireRoles('admin', 'moderator')(req)).toBe(req);
  });

  it('throws 403 when the principal holds none of them', () => {
    const req = authenticatedReq(['user']);

    try {
      requireRoles('admin')(req);
      throw new Error('expected requireRoles to throw');
    } catch (err) {
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).code).toBe('FORBIDDEN');
    }
  });

  it('refuses an empty role list at wiring time', () => {
    // Reading `requireRoles()` as "any role will do" is the mistake this
    // prevents; it authorises nobody, and a 403 per request is a slow way to
    // find that out.
    expect(() => requireRoles()).toThrow(RangeError);
  });
});
