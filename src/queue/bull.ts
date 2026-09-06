import type { ConnectionOptions } from 'bullmq';
import { Queue } from 'bullmq';
import type { DeadLetterRecord } from '@/queue/dead-letter';
import { deadLetterQueueName } from '@/queue/dead-letter';
import type { JobEnvelope } from '@/queue/queue.types';

/**
 * Constructing the BullMQ objects, in the two or three ways this service needs
 * them.
 *
 * Thin on purpose: everything with a decision in it lives in `producer.ts`,
 * `worker.ts` and `dead-letter.ts`, and this file exists so that the two
 * composition roots (`app.ts` and `scripts/queue-worker.ts`) do not each
 * hand-roll a `new Queue(...)` and drift apart on the connection options.
 *
 * ## Connection options rather than a client
 *
 * BullMQ accepts either an ioredis instance or the options to build one, and
 * the options are the right choice here even though this service already has an
 * ioredis adapter for streams. A worker needs a *blocking* connection whose
 * `maxRetriesPerRequest` is `null`, and BullMQ sets that itself only on the
 * connections it creates — handed an instance, it warns and carries on with a
 * client that will abandon a blocked command after 20 retries. Letting BullMQ
 * own its connections also means `close()` really closes them, rather than
 * closing a socket the stream consumer is still reading from.
 *
 * ## Why `error` is always listened for
 *
 * `Queue` and `Worker` are both `EventEmitter`s, and Node rethrows an `error`
 * event that has no listener — which turns a Redis blip into an uncaught
 * exception that takes an API replica down. Attaching one is not optional, so
 * it is done here rather than left to each caller to remember.
 */

export interface BullQueueOptions {
  readonly connection: ConnectionOptions;
  readonly queueName: string;
  /**
   * Namespaces every Redis key this queue owns. Defaults to BullMQ's `bull`.
   * Worth setting when one Redis is shared by several services, since the
   * queue name alone is `orders` in all of them.
   */
  readonly prefix?: string;
  /** Reported on a queue-level error. Default: logs. Never rethrows. */
  readonly onError?: (error: Error) => void;
}

/** Builds the connection options from a Redis URL. */
export function jobQueueConnection(url: string): ConnectionOptions {
  if (url === '') {
    throw new Error(
      'jobQueueConnection: REDIS_URL is empty. The job queue has nothing to connect to — ' +
        'set it, or do not construct a queue.',
    );
  }
  return { url };
}

function defaultOnError(queueName: string): (error: Error) => void {
  return (error: Error): void => {
    console.error(`[queue] queue "${queueName}" error:`, error);
  };
}

/** The queue jobs are produced onto and consumed from. */
export function createJobQueue(options: BullQueueOptions): Queue<JobEnvelope, void, string> {
  const { connection, queueName, prefix, onError = defaultOnError(queueName) } = options;

  const queue = new Queue<JobEnvelope, void, string>(queueName, {
    connection,
    ...(prefix === undefined ? {} : { prefix }),
  });
  queue.on('error', onError);
  return queue;
}

/**
 * The companion queue terminal failures are copied to.
 *
 * Named from the source queue rather than taken as a free-form string, so the
 * producer, the worker and whatever a person opens to read the records cannot
 * end up pointing at three different keys. It shares the source queue's prefix
 * for the same reason.
 */
export function createDeadLetterQueue(
  options: BullQueueOptions,
): Queue<DeadLetterRecord, void, string> {
  const { connection, queueName, prefix, onError } = options;
  const name = deadLetterQueueName(queueName);

  const queue = new Queue<DeadLetterRecord, void, string>(name, {
    connection,
    ...(prefix === undefined ? {} : { prefix }),
  });
  queue.on('error', onError ?? defaultOnError(name));
  return queue;
}
