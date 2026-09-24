import { passesIbanChecksum, passesLuhn, redactText } from '@/logging/value-patterns';
import { FAKE_JWT } from '@/logging/jwt.fixture';
import {
  REDACTED,
  REDACTED_CARD,
  REDACTED_EMAIL,
  REDACTED_IBAN,
  REDACTED_JWT,
} from '@/logging/redaction.types';

// Every literal below is a documentation example or a scheme's published test
// number. Nothing here authenticates against anything.
const TEST_CARD = '4111 1111 1111 1111';
const TEST_IBAN = 'GB82 WEST 1234 5698 7654 32';

describe('passesLuhn', () => {
  it('accepts a published test number', () => {
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('5500005555555559')).toBe(true);
  });

  it('rejects a number one digit off', () => {
    expect(passesLuhn('4111111111111112')).toBe(false);
  });

  it('rejects anything outside 13–19 digits', () => {
    expect(passesLuhn('411111111111')).toBe(false);
    expect(passesLuhn('41111111111111111111')).toBe(false);
  });

  it('rejects a string that is not all digits', () => {
    expect(passesLuhn('4111-1111-1111-1111')).toBe(false);
  });
});

describe('passesIbanChecksum', () => {
  it('accepts the published example, spaced or not', () => {
    expect(passesIbanChecksum(TEST_IBAN)).toBe(true);
    expect(passesIbanChecksum('GB82WEST12345698765432')).toBe(true);
  });

  it('rejects wrong check digits', () => {
    expect(passesIbanChecksum('GB00WEST12345698765432')).toBe(false);
  });

  it('rejects the wrong shape or length', () => {
    expect(passesIbanChecksum('GB82')).toBe(false);
    expect(passesIbanChecksum('8212WEST12345698765432')).toBe(false);
    expect(passesIbanChecksum(`GB82WEST${'1'.repeat(40)}`)).toBe(false);
  });
});

describe('redactText', () => {
  it('keeps the scheme and drops the credential', () => {
    expect(redactText('authorization: Bearer abc.def-ghi')).toBe(
      `authorization: Bearer ${REDACTED}`,
    );
    expect(redactText('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
  });

  it('matches the scheme case-insensitively and echoes it back as written', () => {
    expect(redactText('bearer abc123')).toBe(`bearer ${REDACTED}`);
  });

  it('removes a bare JWT', () => {
    expect(redactText(`upstream said ${FAKE_JWT}`)).toBe(`upstream said ${REDACTED_JWT}`);
  });

  it('prefers the scheme marker when a JWT is presented as a bearer token', () => {
    expect(redactText(`Bearer ${FAKE_JWT}`)).toBe(`Bearer ${REDACTED}`);
  });

  it('removes a card number, grouped or not', () => {
    expect(redactText(`card ${TEST_CARD}`)).toBe(`card ${REDACTED_CARD}`);
    expect(redactText('card 4111111111111111')).toBe(`card ${REDACTED_CARD}`);
    expect(redactText('card 4111-1111-1111-1111')).toBe(`card ${REDACTED_CARD}`);
  });

  it('leaves long digit runs that are not cards alone', () => {
    // The whole reason Luhn is in the path: these are the numbers an operator
    // is reading the log for.
    expect(redactText('order 1234567890123456')).toBe('order 1234567890123456');
    expect(redactText('at 1717171717171')).toBe('at 1717171717171');
    expect(redactText('id 41111111111111111111')).toBe('id 41111111111111111111');
  });

  it('removes an IBAN and leaves a lookalike that fails mod-97', () => {
    expect(redactText(`to ${TEST_IBAN}`)).toBe(`to ${REDACTED_IBAN}`);
    expect(redactText('to GB00WEST12345698765432')).toBe('to GB00WEST12345698765432');
  });

  it('gives back the word it had to over-capture to find the IBAN', () => {
    // The greedy match takes one group too many; the account number must still
    // go, and the word after it must still reach the later passes intact.
    expect(redactText(`to ${TEST_IBAN} ada@example.com`)).toBe(
      `to ${REDACTED_IBAN} ${REDACTED_EMAIL}`,
    );
    expect(redactText(`to ${TEST_IBAN} now`)).toBe(`to ${REDACTED_IBAN} now`);
  });

  it('removes an email address', () => {
    expect(redactText('login failed for ada@example.com')).toBe(
      `login failed for ${REDACTED_EMAIL}`,
    );
    expect(redactText('ada.lovelace+test@mail.example.co.uk')).toBe(REDACTED_EMAIL);
  });

  it('removes every occurrence, not only the first', () => {
    expect(redactText('a@example.com and b@example.com')).toBe(
      `${REDACTED_EMAIL} and ${REDACTED_EMAIL}`,
    );
  });

  it('leaves ordinary text untouched', () => {
    const line = 'GET /v1/users 200 in 12ms [req-7] version 1.2.3';
    expect(redactText(line)).toBe(line);
  });

  it('is idempotent: a marker is not matched by any pattern', () => {
    const once = redactText(`${TEST_CARD} ${TEST_IBAN} ada@example.com Bearer abc ${FAKE_JWT}`);
    expect(redactText(once)).toBe(once);
  });
});
