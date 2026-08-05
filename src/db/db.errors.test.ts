import { DatabaseError } from 'pg';
import { postgresErrorTranslator } from '@/db/db.errors';

function dbError(code: string, message = 'pg said no'): DatabaseError {
  const err = new DatabaseError(message, 0, 'error');
  err.code = code;
  return err;
}

describe('postgresErrorTranslator', () => {
  it('maps a unique violation to 409 — a duplicate email is not a server fault', () => {
    expect(postgresErrorTranslator(dbError('23505'))).toEqual({
      statusCode: 409,
      code: 'UNIQUE_VIOLATION',
      message: 'A record with those values already exists',
    });
  });

  it('maps a foreign key violation to 409', () => {
    expect(postgresErrorTranslator(dbError('23503'))).toMatchObject({
      statusCode: 409,
      code: 'FOREIGN_KEY_VIOLATION',
    });
  });

  it('maps a not-null violation to 422', () => {
    expect(postgresErrorTranslator(dbError('23502'))).toMatchObject({
      statusCode: 422,
      code: 'NOT_NULL_VIOLATION',
    });
  });

  it('maps a check violation to 422', () => {
    expect(postgresErrorTranslator(dbError('23514'))).toMatchObject({
      statusCode: 422,
      code: 'CHECK_VIOLATION',
    });
  });

  it('maps invalid input syntax to 400', () => {
    expect(postgresErrorTranslator(dbError('22P02'))).toMatchObject({
      statusCode: 400,
      code: 'INVALID_INPUT_SYNTAX',
    });
  });

  it('never forwards the driver message, which names constraints and values', () => {
    const translated = postgresErrorTranslator(
      dbError('23505', 'duplicate key value violates unique constraint "users_email_key"'),
    );
    expect(translated?.message).not.toContain('users_email_key');
  });

  it('declines an unmapped SQLSTATE so it stays a 500', () => {
    // 42P01 = undefined_table. That is a bug in our SQL, not a client error.
    expect(postgresErrorTranslator(dbError('42P01'))).toBeNull();
  });

  it('declines a DatabaseError with no code', () => {
    expect(postgresErrorTranslator(new DatabaseError('no code', 0, 'error'))).toBeNull();
  });

  it('declines anything that is not a DatabaseError', () => {
    expect(postgresErrorTranslator(new Error('23505'))).toBeNull();
    expect(postgresErrorTranslator({ code: '23505' })).toBeNull();
  });
});
