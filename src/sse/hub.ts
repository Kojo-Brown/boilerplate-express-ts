import { SseEventLog } from '@/sse/event-log';
import type { ResumeResetReason, StreamMessage } from '@/sse/event-log';
import type { SseCloseReason, SseConnection } from '@/sse/connection';

/**
 * The fan-out: one published event, N open streams, plus the replay a
 * reconnecting stream is owed.
 *
 * It holds `SseConnection`s, never a `Response`, so everything here can be
 * exercised against a handful of fakes.
 */

/**
 * The control event every stream receives first.
 *
 * It exists because "your resume worked" and "your resume was refused" are
 * otherwise indistinguishable to a client: both are a connection that opens and
 * then goes quiet, and the difference between them is whether the client is
 * looking at a complete view or a view missing an unknown number of events. A
 * client that receives `resume: "reset"` must re-read state from the REST API
 * before trusting the stream again; on `live` or `replayed` it may keep what it
 * has.
 *
 * It carries no `id`, so it does not move the client's cursor — see
 * `SseFrame.id`.
 */
export const STREAM_OPEN_EVENT = 'stream.open';

export interface StreamOpenPayload {
  readonly streamId: string;
  /** `live`: nothing was missed. `replayed`: the gap was sent. `reset`: re-read state. */
  readonly resume: 'live' | 'replayed' | 'reset';
  /** Events replayed before this connection went live. */
  readonly replayed: number;
  /** Present only when `resume` is `reset`. */
  readonly reason?: ResumeResetReason;
}

export interface SseHubOptions {
  /** Passed to the replay log. See `EventLogOptions.capacity`. */
  readonly replayBufferSize: number;

  /**
   * Concurrent streams this process will hold open.
   *
   * Every one of them is a socket, a heartbeat timer, and a share of the write
   * amplification on every publish, and none of it is bounded by anything else
   * — an event stream has no request that ends. The ceiling is enforced by the
   * controller *before* the response is committed, because 503 is not something
   * a stream that has already sent its headers can say.
   */
  readonly maxConnections: number;

  /** Injected so ids are deterministic under test. */
  readonly streamId?: string;
}

export interface SseHub {
  readonly connectionCount: number;
  readonly maxConnections: number;
  readonly streamId: string;

  /** Whether `attach` would be within the ceiling. Checked before headers are sent. */
  hasCapacity(): boolean;

  /**
   * Records an event and writes it to every open stream.
   *
   * `payload` is serialised once, here, and the resulting string is what every
   * connection and the replay log hold — N sockets cost one `JSON.stringify`,
   * and a payload the publisher goes on to mutate cannot change what a replay
   * delivers.
   */
  publish(event: string, payload: unknown): StreamMessage;

  /**
   * Adds a connection, replaying what its cursor entitles it to first.
   *
   * Synchronous, and that is a correctness property rather than a style
   * preference: the replay is read from the log and the connection is added to
   * the live set with no `await` between them, so an event published in the
   * meantime is impossible. Introduce one — a database read to authorise the
   * subscription, say — and any event published during it is delivered to
   * neither half, which is the classic resume race and is invisible under any
   * load a test generates.
   */
  attach(connection: SseConnection, lastEventId: string | undefined): void;

  /** Ends every stream. For shutdown, and for test teardown. */
  closeAll(reason?: SseCloseReason): void;
}

export function createSseHub(options: SseHubOptions): SseHub {
  const { replayBufferSize, maxConnections } = options;

  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new RangeError(
      `createSseHub: maxConnections must be an integer >= 1, received ${maxConnections}`,
    );
  }

  const log = new SseEventLog({
    capacity: replayBufferSize,
    ...(options.streamId !== undefined ? { streamId: options.streamId } : {}),
  });

  const connections = new Set<SseConnection>();

  return {
    get connectionCount(): number {
      return connections.size;
    },

    maxConnections,

    get streamId(): string {
      return log.streamId;
    },

    hasCapacity(): boolean {
      return connections.size < maxConnections;
    },

    publish(event: string, payload: unknown): StreamMessage {
      const message = log.append(event, JSON.stringify(payload));

      for (const connection of connections) {
        // No try/catch and no filtering of closed connections: `send` is a
        // no-op once closed, and a connection that closes *during* this loop
        // removes itself through its own close listener. Iterating a `Set`
        // being deleted from is defined behaviour — a member removed before it
        // is reached is not visited.
        connection.send(message);
      }

      return message;
    },

    attach(connection: SseConnection, lastEventId: string | undefined): void {
      const outcome = log.since(lastEventId);

      const open: StreamOpenPayload = {
        streamId: log.streamId,
        resume: outcome.kind === 'replay' ? 'replayed' : outcome.kind === 'reset' ? 'reset' : 'live',
        replayed: outcome.kind === 'replay' ? outcome.messages.length : 0,
        ...(outcome.kind === 'reset' ? { reason: outcome.reason } : {}),
      };

      // Registered before anything is written, because a replay large enough to
      // trip the slow-consumer ceiling closes the connection *during* the loop
      // below — and a listener attached after that point would never run.
      connection.onClose(() => {
        connections.delete(connection);
      });

      // Ahead of the replay, so a client can decide what to do with what
      // follows before it arrives rather than after.
      connection.control(STREAM_OPEN_EVENT, open);

      if (outcome.kind === 'replay') {
        for (const message of outcome.messages) {
          connection.send(message);
        }
      }

      // The check the listener above cannot make on its own: a connection that
      // died during the replay must not be added afterwards, or it stays in the
      // set for the life of the process holding a slot against `maxConnections`.
      if (!connection.closed) {
        connections.add(connection);
      }
    },

    closeAll(reason: SseCloseReason = 'server-shutdown'): void {
      // Snapshotted: `close` runs the listener that deletes from this set.
      for (const connection of [...connections]) {
        connection.close(reason);
      }
      connections.clear();
    },
  };
}
