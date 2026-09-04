import { describeFailure, MAX_LAST_ERROR_LENGTH } from '@/lib/describe-error';

describe('describeFailure', () => {
  it('renders an error as name and message', () => {
    expect(describeFailure(new TypeError('nope'))).toBe('TypeError: nope');
  });

  it('keeps a custom error name', () => {
    class WeirdError extends Error {
      constructor() {
        super('sideways');
        this.name = 'WeirdError';
      }
    }
    expect(describeFailure(new WeirdError())).toBe('WeirdError: sideways');
  });

  it('labels a thrown non-error rather than stringifying it silently', () => {
    // A caller reading `last_error` needs to know the producer threw a string,
    // because that is the bug — not just what the string said.
    expect(describeFailure('boom')).toBe('Non-error thrown: boom');
    expect(describeFailure(undefined)).toBe('Non-error thrown: undefined');
    expect(describeFailure({ code: 42 })).toBe('Non-error thrown: [object Object]');
  });

  it('truncates to the cap, ellipsis included', () => {
    const described = describeFailure(new Error('x'.repeat(MAX_LAST_ERROR_LENGTH * 2)));

    expect(described).toHaveLength(MAX_LAST_ERROR_LENGTH);
    expect(described.endsWith('…')).toBe(true);
  });

  it('leaves a message exactly at the cap alone', () => {
    // The boundary is where an off-by-one would put an ellipsis on text that
    // fits — and then every stored reason would end in one.
    const message = 'y'.repeat(MAX_LAST_ERROR_LENGTH - 'Error: '.length);
    const described = describeFailure(new Error(message));

    expect(described).toHaveLength(MAX_LAST_ERROR_LENGTH);
    expect(described.endsWith('…')).toBe(false);
  });
});
