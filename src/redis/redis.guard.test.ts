/**
 * The test that stops a convenience from becoming a lie.
 *
 * `redis.integration.test.ts` skips itself when `REDIS_TEST_URL` is unset, so
 * that a contributor without a Redis running can still get a green `pnpm test`.
 * That is a reasonable trade locally and an unacceptable one in CI: a skipped
 * suite reports exactly the same colour as a passing one, so a workflow edit
 * that dropped the service — or a rename of the variable — would leave the only
 * evidence about how this code behaves against a real server silently unrun,
 * for as long as it took somebody to notice.
 *
 * So the skip is allowed only where a person is watching.
 */
describe('redis integration coverage', () => {
  it('is not silently skipped in CI', () => {
    const isCi = process.env['CI'] === 'true' || process.env['CI'] === '1';

    if (!isCi) {
      expect(isCi).toBe(false);
      return;
    }

    expect(process.env['REDIS_TEST_URL'] ?? '').not.toBe('');
  });
});
