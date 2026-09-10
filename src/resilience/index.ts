export type {
  CircuitBreakerOptions,
  CircuitOutcome,
  CircuitPermit,
  CircuitState,
  CircuitStateChange,
  CircuitStats,
} from '@/resilience/circuit-breaker';
export { CircuitBreaker, CircuitOpenError } from '@/resilience/circuit-breaker';

export type {
  BulkheadOptions,
  BulkheadPermit,
  BulkheadRejectionReason,
  BulkheadStats,
} from '@/resilience/bulkhead';
export { Bulkhead, BulkheadFullError, withBulkhead } from '@/resilience/bulkhead';

export type {
  AttemptDeadlineOptions,
  AttemptDeadlines,
  DeadlinePhase,
} from '@/resilience/deadlines';
export {
  DependencyTimeoutError,
  guardBodyIdle,
  startAttemptDeadlines,
} from '@/resilience/deadlines';

export type {
  FetchLike,
  HttpClient,
  HttpClientOptions,
  HttpRequestInit,
  ResponseOutcome,
  RetryNotice,
  RetryPolicy,
} from '@/resilience/http-client';
export {
  DEFAULT_RETRY_POLICY,
  classifyResponse,
  createHttpClient,
  isRetryableTransportError,
} from '@/resilience/http-client';

export { createDependencyClient } from '@/resilience/dependency-client';
