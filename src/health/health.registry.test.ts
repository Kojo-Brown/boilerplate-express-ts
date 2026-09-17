import { DuplicateHealthCheckError } from '@/health/health.errors';
import {
  clearHealthChecks,
  registerHealthCheck,
  registeredHealthChecks,
} from '@/health/health.registry';
import type { DependencyCheck } from '@/health/health.types';

const check = (name: string): DependencyCheck => ({
  name,
  criticality: 'critical',
  run: () => Promise.resolve(),
});

describe('health check registry', () => {
  afterEach(() => {
    clearHealthChecks();
  });

  it('keeps registration order, which is the order a report is read in', () => {
    registerHealthCheck(check('postgres'));
    registerHealthCheck(check('redis'));

    expect(registeredHealthChecks().map((entry) => entry.name)).toEqual(['postgres', 'redis']);
  });

  it('refuses a second check under the same name, at boot', () => {
    // The duplicate does not fail: it produces a report naming the same
    // dependency twice, and `postgres: ok, postgres: failed` is unreadable.
    registerHealthCheck(check('postgres'));

    expect(() => registerHealthCheck(check('postgres'))).toThrow(DuplicateHealthCheckError);
    expect(registeredHealthChecks()).toHaveLength(1);
  });

  it('compares by name and not by identity', () => {
    // `createPostgresCheck` returns a fresh object per call, so identity would
    // let the duplicate straight through.
    const first = check('postgres');
    const second = check('postgres');
    expect(first).not.toBe(second);

    registerHealthCheck(first);
    expect(() => registerHealthCheck(second)).toThrow(DuplicateHealthCheckError);
  });

  it('hands out a frozen copy, so a caller cannot reorder the report', () => {
    registerHealthCheck(check('postgres'));
    const listed = registeredHealthChecks();

    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => (listed as DependencyCheck[]).push(check('redis'))).toThrow(TypeError);
    expect(registeredHealthChecks()).toHaveLength(1);
  });

  it('starts empty, which is what an app built by a test gets', () => {
    expect(registeredHealthChecks()).toEqual([]);
  });
});
