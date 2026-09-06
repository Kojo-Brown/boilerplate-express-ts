import { UnrecoverableError } from 'bullmq';
import {
  DeadLetterWriteError,
  describeFailure,
  MalformedJobDataError,
  UnknownJobNameError,
  UnprocessableJobError,
} from '@/queue/queue.errors';

describe('UnprocessableJobError', () => {
  it('is an UnrecoverableError, which is what BullMQ actually checks', () => {
    // The check happens inside `Job#shouldRetryJob`, where none of our code
    // runs. Subclassing is the only thing that reaches it — an error merely
    // named the same would work today and stop working the moment BullMQ
    // tightened the check, and an error recognised by our own `catch` would
    // never reach the decision at all.
    expect(new UnprocessableJobError('gone')).toBeInstanceOf(UnrecoverableError);
  });

  it('keeps its own name so a dead-letter record says which one it was', () => {
    // `UnrecoverableError`'s constructor sets `name` from `this.constructor`,
    // which would make every subclass report its own class name — fine here,
    // and pinned because `failedReason` is built from it.
    expect(describeFailure(new UnprocessableJobError('gone'))).toBe(
      'UnprocessableJobError: gone',
    );
  });

  it('carries the failure it was raised over', () => {
    const cause = new TypeError('user is undefined');

    // The thing that actually went wrong is usually the wrapped error, and a
    // record naming only the wrapper is a record of the decision rather than of
    // the failure.
    expect(new UnprocessableJobError('gone', { cause }).cause).toBe(cause);
  });

  it('leaves `cause` unset when none was given', () => {
    expect('cause' in new UnprocessableJobError('gone')).toBe(false);
  });
});

describe('MalformedJobDataError', () => {
  it('is unprocessable, because the stored bytes do not change between attempts', () => {
    const error = new MalformedJobDataError('email.send', 'expected an object');

    expect(error).toBeInstanceOf(UnprocessableJobError);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toContain('email.send');
    expect(error.message).toContain('expected an object');
  });
});

describe('UnknownJobNameError', () => {
  it('is retryable, because the ordinary cause is a rolling deploy', () => {
    const error = new UnknownJobNameError('user.suspend', ['email.send']);

    // Not unprocessable: the new version enqueues a name an old worker replica
    // has never heard of, the deploy finishes, and the next attempt succeeds.
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it('lists what this build does know, which is what identifies the skew', () => {
    const error = new UnknownJobNameError('user.suspend', ['email.send', 'report.export']);

    expect(error.message).toContain('user.suspend');
    expect(error.message).toContain('email.send, report.export');
    expect(error.known).toEqual(['email.send', 'report.export']);
  });
});

describe('DeadLetterWriteError', () => {
  it('names the job it could not record, and what stopped it', () => {
    const cause = new Error('connection reset');
    const error = new DeadLetterWriteError('jobs', '42', { cause });

    // "Adding to the dead-letter queue failed" and "the job failed" are
    // different incidents that would otherwise arrive as the same log line.
    expect(error.queueName).toBe('jobs');
    expect(error.jobId).toBe('42');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('42');
  });
});
