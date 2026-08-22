import { AppError } from '@/lib/errors';
import { isTaskResponse, serializeError } from '@/workers/protocol';

describe('serializeError', () => {
  it('keeps name, message and stack from a plain Error', () => {
    const error = new Error('boom');

    const serialized = serializeError(error);

    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');
    expect(serialized.stack).toContain('boom');
  });

  // The reason this function exists: structured clone would carry the Error and
  // silently drop both of these, so a task that deliberately answered 400 would
  // reach the caller as an anonymous 500.
  it('keeps the statusCode and code of an AppError', () => {
    const serialized = serializeError(new AppError(422, 'bad input', 'BAD_INPUT'));

    expect(serialized).toMatchObject({
      name: 'AppError',
      message: 'bad input',
      code: 'BAD_INPUT',
      statusCode: 422,
    });
  });

  it("keeps Node's err.code from a system error", () => {
    const error = Object.assign(new Error('no such file'), { code: 'ENOENT' });

    expect(serializeError(error).code).toBe('ENOENT');
  });

  it('omits absent fields rather than emitting undefined values', () => {
    const serialized = serializeError(new Error('plain'));

    expect(Object.keys(serialized)).not.toContain('code');
    expect(Object.keys(serialized)).not.toContain('statusCode');
  });

  it.each([
    ['a string', 'nope', 'nope'],
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('stringifies %s thrown as a non-object', (_label, thrown, expected) => {
    expect(serializeError(thrown)).toEqual({ name: 'Error', message: expected });
  });

  it('ignores non-string name and message properties instead of trusting them', () => {
    const serialized = serializeError({ name: 7, message: { nested: true } });

    expect(serialized.name).toBe('Error');
    expect(typeof serialized.message).toBe('string');
  });

  it('ignores a non-finite statusCode', () => {
    expect(serializeError({ message: 'x', statusCode: Number.NaN }).statusCode).toBeUndefined();
  });
});

describe('isTaskResponse', () => {
  it('accepts a success and a failure envelope', () => {
    expect(isTaskResponse({ kind: 'result', id: 1, ok: true, value: 'x' })).toBe(true);
    expect(
      isTaskResponse({ kind: 'result', id: 1, ok: false, error: { name: 'E', message: 'm' } }),
    ).toBe(true);
  });

  // A worker entry is free to postMessage things of its own. None of them may
  // be able to settle a caller's promise by accident.
  it.each([
    ['a non-object', 'result'],
    ['null', null],
    ['a message with another kind', { kind: 'progress', id: 1, ok: true }],
    ['a message with no id', { kind: 'result', ok: true }],
    ['a message whose id is not a number', { kind: 'result', id: '1', ok: true }],
    ['a message whose ok is not a boolean', { kind: 'result', id: 1, ok: 'yes' }],
  ])('rejects %s', (_label, value) => {
    expect(isTaskResponse(value)).toBe(false);
  });
});
