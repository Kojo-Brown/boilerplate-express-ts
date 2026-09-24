import {
  DEFAULT_SENSITIVE_KEYS,
  createSensitiveKeyMatcher,
  keyRuns,
} from '@/logging/key-policy';

describe('keyRuns', () => {
  it('splits camelCase into words', () => {
    expect(keyRuns('userEmail')).toEqual(['user', 'useremail', 'email']);
  });

  it('splits on separators', () => {
    expect(keyRuns('x-api-key')).toContain('apikey');
    expect(keyRuns('user_email_address')).toContain('email');
  });

  it('keeps an acronym together instead of splitting each letter', () => {
    // `APIKey` must become `api|key`, not `a|p|i|key` — the latter produces no
    // run spelling `apikey` and the field goes unredacted.
    expect(keyRuns('APIKey')).toContain('apikey');
    expect(keyRuns('SSNValue')).toContain('ssn');
  });

  it('splits the letter-to-digit boundary', () => {
    expect(keyRuns('address2')).toContain('address');
  });

  it('joins at most four adjacent words', () => {
    const runs = keyRuns('one.two.three.four.five');
    expect(runs).toContain('onetwothreefour');
    expect(runs).not.toContain('onetwothreefourfive');
  });

  it('yields nothing for a key with no alphanumerics', () => {
    expect(keyRuns('---')).toEqual([]);
  });
});

describe('createSensitiveKeyMatcher', () => {
  const isSensitive = createSensitiveKeyMatcher();

  it.each([
    'password',
    'Password',
    'user_password',
    'currentPassword',
    'accessToken',
    'refresh_token',
    'apiKey',
    'X-API-Key',
    'authorization',
    'setCookie',
    'sessionId',
    'email',
    'userEmail',
    'customerEmailAddress',
    'phoneNumber',
    'ssn',
    'dateOfBirth',
    'firstName',
    'streetAddress',
    'postalCode',
    'cardNumber',
    'cvv',
    'iban',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitive(key)).toBe(true);
  });

  it.each([
    // The words that a substring matcher eats and an operator needs.
    'passengers',
    'passed',
    'discardedAt',
    'eventName',
    'queueName',
    'userId',
    'ipAddress',
    'remoteAddress',
    'signature',
    'tokenizer',
    'emailsSentCount',
    'correlationId',
    'statusCode',
  ])('leaves %s alone', (key) => {
    expect(isSensitive(key)).toBe(false);
  });

  it('accepts deployment-specific keys in any spelling', () => {
    const withExtras = createSensitiveKeyMatcher(['ip_address', 'Policy-Number']);

    expect(withExtras('ipAddress')).toBe(true);
    expect(withExtras('remoteIpAddress')).toBe(true);
    expect(withExtras('policyNumber')).toBe(true);
    // Still nothing the built-ins would not have caught.
    expect(withExtras('eventName')).toBe(false);
  });

  it('ignores blank entries in the extra list', () => {
    const withBlanks = createSensitiveKeyMatcher(['', '  ', '-']);
    expect(withBlanks('eventName')).toBe(false);
    expect(withBlanks('password')).toBe(true);
  });

  it('answers the same way for a repeated key, cached or not', () => {
    const matcher = createSensitiveKeyMatcher();
    expect(matcher('userEmail')).toBe(true);
    expect(matcher('userEmail')).toBe(true);
    expect(matcher('eventName')).toBe(false);
    expect(matcher('eventName')).toBe(false);
  });

  it('stays correct after the memo is cleared by a flood of distinct keys', () => {
    // The cache clears wholesale past its bound; a matcher that answered from a
    // half-cleared map would be the one bug that makes the bound dangerous.
    const matcher = createSensitiveKeyMatcher();
    for (let index = 0; index < 5_000; index += 1) matcher(`field${index}`);

    expect(matcher('password')).toBe(true);
    expect(matcher('field1')).toBe(false);
  });

  it('exposes the built-in terms already normalised', () => {
    for (const term of DEFAULT_SENSITIVE_KEYS) {
      expect(term).toMatch(/^[a-z0-9]+$/u);
    }
  });
});
