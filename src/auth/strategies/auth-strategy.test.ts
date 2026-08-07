import { z } from 'zod';
import {
  AUTH_STRATEGIES,
  defineAuthStrategy,
} from '@/auth/strategies/auth-strategy.types';
import type { AuthenticatedPrincipal } from '@/auth/strategies/auth-strategy.types';
import { AppError, ValidationError } from '@/lib/errors';

const principal: AuthenticatedPrincipal = {
  id: 'u-1',
  email: 'defined@example.com',
  roles: ['user'],
};

function makeStrategy(
  authenticate: (credentials: { pin: string }) => Promise<AuthenticatedPrincipal>,
) {
  return defineAuthStrategy({
    name: 'password',
    credentials: z.object({ pin: z.string().min(4) }),
    authenticate,
  });
}

describe('AUTH_STRATEGIES', () => {
  it('lists every strategy exactly once', () => {
    expect([...new Set(AUTH_STRATEGIES)]).toHaveLength(AUTH_STRATEGIES.length);
  });

  it('uses names that are safe as a URL path segment', () => {
    for (const name of AUTH_STRATEGIES) {
      expect(name).toBe(encodeURIComponent(name));
    }
  });
});

describe('defineAuthStrategy', () => {
  it('exposes the name it was defined with', () => {
    const strategy = makeStrategy(() => Promise.resolve(principal));
    expect(strategy.name).toBe('password');
  });

  it('hands the parsed credentials to the definition', async () => {
    const seen: unknown[] = [];
    const strategy = makeStrategy((credentials) => {
      seen.push(credentials);
      return Promise.resolve(principal);
    });

    await strategy.authenticate({ pin: '1234' });

    expect(seen).toEqual([{ pin: '1234' }]);
  });

  it('returns the principal the definition resolved', async () => {
    const strategy = makeStrategy(() => Promise.resolve(principal));

    await expect(strategy.authenticate({ pin: '1234' })).resolves.toEqual(principal);
  });

  it('strips properties the schema does not declare', async () => {
    const seen: unknown[] = [];
    const strategy = makeStrategy((credentials) => {
      seen.push(credentials);
      return Promise.resolve(principal);
    });

    await strategy.authenticate({ pin: '1234', role: 'admin' });

    // Zod's default `strip` behaviour, and worth an assertion: it is what stops
    // a caller smuggling extra fields into a strategy that later grows a
    // property with that name.
    expect(seen).toEqual([{ pin: '1234' }]);
  });

  it('raises a ValidationError carrying the zod issues when the shape is wrong', async () => {
    const strategy = makeStrategy(() => Promise.resolve(principal));

    await expect(strategy.authenticate({ pin: '12' })).rejects.toBeInstanceOf(ValidationError);
    await expect(strategy.authenticate({ pin: '12' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('populates issues so the error middleware can echo them', async () => {
    const strategy = makeStrategy(() => Promise.resolve(principal));

    await expect(strategy.authenticate({})).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ['pin'] })],
    });
  });

  it('rejects a non-object body rather than coercing it', async () => {
    const strategy = makeStrategy(() => Promise.resolve(principal));

    await expect(strategy.authenticate('1234')).rejects.toBeInstanceOf(ValidationError);
    await expect(strategy.authenticate(undefined)).rejects.toBeInstanceOf(ValidationError);
  });

  it('never calls the definition when validation fails', async () => {
    const authenticate = jest.fn(() => Promise.resolve(principal));
    const strategy = makeStrategy(authenticate);

    await expect(strategy.authenticate({})).rejects.toBeInstanceOf(ValidationError);

    expect(authenticate).not.toHaveBeenCalled();
  });

  it('propagates an authentication failure unchanged', async () => {
    const strategy = makeStrategy(() =>
      Promise.reject(new AppError(401, 'nope', 'AUTH_INVALID_CREDENTIALS')),
    );

    await expect(strategy.authenticate({ pin: '1234' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_CREDENTIALS',
    });
  });
});
