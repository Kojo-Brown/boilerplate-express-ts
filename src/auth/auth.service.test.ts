import { authService } from '@/auth/auth.service';
import { tokenStore } from '@/auth/token-store';

// env vars injected via jest.setup.ts before any module is loaded

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

describe('authService.login', () => {
  it('returns tokens and user on valid credentials', async () => {
    const result = await authService.login({
      email: 'admin@example.com',
      password: 'password',
    });

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user.email).toBe('admin@example.com');
    expect(result.user.roles).toContain('admin');
  });

  it('stores the refresh token in the token store', async () => {
    const before = tokenStore.size();
    await authService.login({ email: 'user@example.com', password: 'password' });
    expect(tokenStore.size()).toBeGreaterThan(before);
  });

  it('throws 401 on wrong password', async () => {
    await expect(
      authService.login({ email: 'admin@example.com', password: 'wrong' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws 401 on unknown email', async () => {
    await expect(
      authService.login({ email: 'nobody@example.com', password: 'password' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.refresh', () => {
  it('issues a rotated token pair for a valid refresh token', async () => {
    const { refreshToken } = await authService.login({
      email: 'user@example.com',
      password: 'password',
    });

    const result = await authService.refresh(refreshToken);

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.refreshToken).not.toBe(refreshToken);
  });

  it('rejects a refresh token that was already used (rotation)', async () => {
    const { refreshToken } = await authService.login({
      email: 'admin@example.com',
      password: 'password',
    });

    await authService.refresh(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a revoked refresh token', async () => {
    const { refreshToken } = await authService.login({
      email: 'user@example.com',
      password: 'password',
    });

    await authService.logout(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a garbage token string', async () => {
    await expect(authService.refresh('not.a.valid.token')).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe('authService.logout', () => {
  it('revokes the refresh token', async () => {
    const { refreshToken } = await authService.login({
      email: 'admin@example.com',
      password: 'password',
    });

    await authService.logout(refreshToken);

    expect(tokenStore.has(refreshToken)).toBe(false);
  });

  it('is idempotent for an already-logged-out token', async () => {
    const { refreshToken } = await authService.login({
      email: 'user@example.com',
      password: 'password',
    });

    await authService.logout(refreshToken);
    await expect(authService.logout(refreshToken)).resolves.toBeUndefined();
  });

  it('is idempotent for a completely invalid token', async () => {
    await expect(authService.logout('garbage-token')).resolves.toBeUndefined();
  });
});

describe('authService.logoutAll', () => {
  it('revokes all refresh tokens for a user', async () => {
    const login1 = await authService.login({ email: 'admin@example.com', password: 'password' });
    const login2 = await authService.login({ email: 'admin@example.com', password: 'password' });

    await authService.logoutAll('1');

    expect(tokenStore.has(login1.refreshToken)).toBe(false);
    expect(tokenStore.has(login2.refreshToken)).toBe(false);
  });
});
