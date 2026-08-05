import { AppError, ValidationError } from '@/lib/errors';
import {
  registerErrorTranslator,
  translateError,
  type ErrorTranslator,
} from '@/lib/error-translators';

describe('translateError — core translators', () => {
  it('maps an AppError to its own status and code', () => {
    expect(translateError(new AppError(404, 'User not found', 'NOT_FOUND'))).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'User not found',
    });
  });

  it('falls back to INTERNAL_ERROR when an AppError carries no code', () => {
    expect(translateError(new AppError(503, 'Upstream down'))).toEqual({
      statusCode: 503,
      code: 'INTERNAL_ERROR',
      message: 'Upstream down',
    });
  });

  it('maps a ValidationError to 422 and keeps the issues', () => {
    const issues = [{ path: ['email'], message: 'Invalid email' }];
    const translated = translateError(new ValidationError(issues as never));

    expect(translated).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(translated?.issues).toEqual(issues);
  });

  it('matches ValidationError ahead of its AppError superclass', () => {
    // Ordering regression guard: an AppError-first chain would drop `issues`.
    const translated = translateError(new ValidationError([] as never));
    expect(translated?.issues).toBeDefined();
  });

  it('returns null for an error nothing recognises', () => {
    expect(translateError(new Error('boom'))).toBeNull();
  });

  it('returns null for a non-Error thrown value', () => {
    expect(translateError('a bare string')).toBeNull();
    expect(translateError(undefined)).toBeNull();
  });
});

describe('registerErrorTranslator', () => {
  class WidgetError extends Error {}

  const widgetTranslator: ErrorTranslator = (err) =>
    err instanceof WidgetError
      ? { statusCode: 418, code: 'WIDGET_FAULT', message: 'The widget refused' }
      : null;

  it('teaches the registry a new error family without touching the middleware', () => {
    expect(translateError(new WidgetError('x'))).toBeNull();

    registerErrorTranslator(widgetTranslator);

    expect(translateError(new WidgetError('x'))).toEqual({
      statusCode: 418,
      code: 'WIDGET_FAULT',
      message: 'The widget refused',
    });
  });

  it('is idempotent, so repeated createApp() calls cannot grow the chain', () => {
    registerErrorTranslator(widgetTranslator);
    registerErrorTranslator(widgetTranslator);

    expect(translateError(new WidgetError('x'))).toMatchObject({ code: 'WIDGET_FAULT' });
  });

  it('does not let a registered translator override a core one', () => {
    registerErrorTranslator(() => ({
      statusCode: 500,
      code: 'HIJACKED',
      message: 'should never win',
    }));

    expect(translateError(new AppError(404, 'User not found', 'NOT_FOUND'))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
