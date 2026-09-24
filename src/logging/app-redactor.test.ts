import { getAppRedactor, parseExtraKeys, resetAppRedactor } from '@/logging/app-redactor';
import { REDACTED } from '@/logging/redaction.types';

afterEach(() => {
  resetAppRedactor();
});

describe('parseExtraKeys', () => {
  it('splits, trims and drops the empties a hand-edited list collects', () => {
    expect(parseExtraKeys(' ip_address , policyNumber ,, ')).toEqual([
      'ip_address',
      'policyNumber',
    ]);
  });

  it('reads an unset list as no extra keys', () => {
    expect(parseExtraKeys('')).toEqual([]);
  });
});

describe('the process-wide redactor', () => {
  it('is the same redactor every time, not a new matcher per line', () => {
    // The memo inside the key matcher is the point: rebuilt per call it would
    // be cold on every log line, which is every request.
    expect(getAppRedactor()).toBe(getAppRedactor());
  });

  it('redacts with the built-in policy under the test configuration', () => {
    expect(getAppRedactor()({ userId: 'u-1', password: 'hunter2' })).toEqual({
      userId: 'u-1',
      password: REDACTED,
    });
  });
});
