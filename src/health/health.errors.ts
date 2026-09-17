import { AppError } from '@/lib/errors';

/**
 * A check that did not answer inside its budget.
 *
 * An `AppError` rather than a bare `Error` so that it reads the same way as
 * every other failure in this codebase, and a 503 because that is what an
 * unanswered dependency means — but note that nothing throws this *at* a
 * client: `runCheck` catches it and turns it into a `CheckResult`. The status
 * code is here for the case where a check is reused outside the probe.
 */
export class HealthCheckTimeoutError extends AppError {
  constructor(
    public readonly checkName: string,
    public readonly timeoutMs: number,
  ) {
    super(
      503,
      `Health check "${checkName}" did not answer within ${String(timeoutMs)}ms`,
      'HEALTH_CHECK_TIMEOUT',
    );
    this.name = 'HealthCheckTimeoutError';
  }
}

/**
 * Two checks registered under one name.
 *
 * Thrown at registration — which is boot — rather than tolerated, because the
 * duplicate does not fail: it produces a report with the same name twice, and
 * the operator reading `postgres: ok, postgres: failed` has no way to tell
 * which one is the dependency they are looking at.
 */
export class DuplicateHealthCheckError extends AppError {
  constructor(public readonly checkName: string) {
    super(500, `A health check named "${checkName}" is already registered`, 'DUPLICATE_HEALTH_CHECK');
    this.name = 'DuplicateHealthCheckError';
  }
}
