import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@/lib/errors';
import type { JwtPayload } from '@/auth/auth.types';

const mockVerifyAccessToken = jest.fn<JwtPayload, [string]>();

jest.mock('@/lib/jwt', () => ({
  verifyAccessToken: (token: string): JwtPayload => mockVerifyAccessToken(token),
}));

import { requireAuth, requireRole } from '@/middleware/auth.middleware';

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

  it('attaches decoded payload to req.user and calls next() on a valid token', () => {
    const payload: JwtPayload = { userId: 'u1', roles: ['user'], type: 'access' };
    mockVerifyAccessToken.mockReturnValue(payload);

    const req = mockReq({ headers: { authorization: 'Bearer valid.jwt.token' } });
    const next = jest.fn() as unknown as NextFunction;

    requireAuth(req, mockRes(), next);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith('valid.jwt.token');
    expect((req as Request & { user: JwtPayload }).user).toEqual(payload);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('requireRole', () => {
  const basePayload: JwtPayload = { userId: 'u1', roles: ['user'], type: 'access' };

  it('calls next with 401 AppError when req.user is not set', () => {
    const req = mockReq();
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('calls next with 403 AppError when user does not have the required role', () => {
    const req = mockReq() as Request & { user: JwtPayload };
    req.user = { ...basePayload, roles: ['user'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('calls next() when user has the single required role', () => {
    const req = mockReq() as Request & { user: JwtPayload };
    req.user = { ...basePayload, roles: ['admin'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() when user has at least one of the required roles', () => {
    const req = mockReq() as Request & { user: JwtPayload };
    req.user = { ...basePayload, roles: ['moderator'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin', 'moderator', 'editor')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next with 403 when user has none of the required roles', () => {
    const req = mockReq() as Request & { user: JwtPayload };
    req.user = { ...basePayload, roles: ['user'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin', 'moderator')(req, mockRes(), next);

    const err = (next as jest.Mock).mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(403);
  });

  it('supports multiple roles on the same user', () => {
    const req = mockReq() as Request & { user: JwtPayload };
    req.user = { ...basePayload, roles: ['user', 'admin'] };
    const next = jest.fn() as unknown as NextFunction;

    requireRole('admin')(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });
});
