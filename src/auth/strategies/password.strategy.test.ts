import { createPasswordStrategy } from '@/auth/strategies/password.strategy';
import { ValidationError } from '@/lib/errors';
import type { AuthUser, UserDirectory } from '@/auth/auth.types';

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, hash: string) => hash === `hash-of:${plain}`),
  hashPassword: jest.fn(async (plain: string) => `hash-of:${plain}`),
}));

const KNOWN_USER: AuthUser = {
  id: 'u-3',
  email: 'known@example.com',
  passwordHash: 'hash-of:correct-horse',
  roles: ['user'],
};

const users: UserDirectory = {
  findByEmail(email: string): Promise<AuthUser | null> {
    return Promise.resolve(email === KNOWN_USER.email ? KNOWN_USER : null);
  },
};

const strategy = createPasswordStrategy({ users });

describe('password strategy', () => {
  it('is registered under the name the URL segment uses', () => {
    expect(strategy.name).toBe('password');
  });

  it('resolves the principal on correct credentials', async () => {
    await expect(
      strategy.authenticate({ email: 'known@example.com', password: 'correct-horse' }),
    ).resolves.toEqual({ id: 'u-3', email: 'known@example.com', roles: ['user'] });
  });

  it('copies the roles rather than aliasing the directory record', async () => {
    const principal = await strategy.authenticate({
      email: 'known@example.com',
      password: 'correct-horse',
    });
    principal.roles.push('admin');

    expect(KNOWN_USER.roles).toEqual(['user']);
  });

  it('rejects a wrong password with 401', async () => {
    await expect(
      strategy.authenticate({ email: 'known@example.com', password: 'wrong' }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('rejects an unknown email with 401', async () => {
    await expect(
      strategy.authenticate({ email: 'ghost@example.com', password: 'correct-horse' }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('gives an unknown email and a wrong password the same message', async () => {
    const unknown = await strategy
      .authenticate({ email: 'ghost@example.com', password: 'correct-horse' })
      .catch((e: unknown) => e);
    const wrong = await strategy
      .authenticate({ email: 'known@example.com', password: 'wrong' })
      .catch((e: unknown) => e);

    expect((unknown as Error).message).toBe((wrong as Error).message);
  });

  it('raises a 422, not a 401, when the email is not an email', async () => {
    await expect(
      strategy.authenticate({ email: 'not-an-email', password: 'correct-horse' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('raises a 422 when the password field is missing', async () => {
    await expect(strategy.authenticate({ email: 'known@example.com' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
