/**
 * The Redis Streams subsystem.
 *
 * Three pieces, in the order an event moves through them: a publisher that
 * appends an envelope to a stream, a consumer-group worker that reads entries
 * and reclaims the ones a dead replica left behind, and a parking lot for the
 * entries no amount of retrying will fix. `docs/redis-streams.md` is the map.
 */

export {
  isBusyGroupError,
  isNoGroupError,
  MalformedStreamEntryError,
  StreamHandlerTimeoutError,
  UnexpectedRedisReplyError,
} from '@/redis/redis.errors';

export type {
  AppendOptions,
  ClaimOptions,
  CreateGroupOptions,
  PendingEntry,
  ReadGroupOptions,
  StreamCommands,
  StreamConnections,
  StreamEntry,
} from '@/redis/stream.types';

export { createStreamConnections } from '@/redis/ioredis.adapter';

export type { StreamEventEnvelope } from '@/redis/stream.envelope';
export { decodeEnvelope, encodeEnvelope, ENVELOPE_FIELDS } from '@/redis/stream.envelope';

export type { StreamPublisher, StreamPublisherOptions } from '@/redis/stream.publisher';
export { createStreamPublisher } from '@/redis/stream.publisher';

export type {
  ParkedEntry,
  ParkHandler,
  ParkReason,
  StreamEntryContext,
  StreamHandler,
  StreamTickOutcome,
  StreamWorker,
  StreamWorkerOptions,
} from '@/redis/stream.worker';
export { createStreamWorker } from '@/redis/stream.worker';

export type { ParkingLotOptions } from '@/redis/parking-lot';
export { createParkingLot, PARK_FIELDS, parkedStreamKey } from '@/redis/parking-lot';

export { createStreamOutboxDispatcher } from '@/redis/stream.dispatcher';
export { createEventBusStreamHandler } from '@/redis/bus-consumer';

export type { MemoryStreamOptions } from '@/redis/stream.memory';
export { MemoryStreamCommands, memoryStreamConnections } from '@/redis/stream.memory';
