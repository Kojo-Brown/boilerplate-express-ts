export { WS_CLOSE, MAX_CLOSE_REASON_BYTES, truncateCloseReason } from '@/ws/ws.close';
export type { WsCloseCode } from '@/ws/ws.close';

export { createTokenBucket } from '@/ws/token-bucket';
export type { TokenBucket, TokenBucketOptions } from '@/ws/token-bucket';

export {
  BEARER_SUBPROTOCOL,
  authenticateHandshake,
  millisecondsUntilExpiry,
  readHandshakeToken,
  readOfferedSubprotocols,
} from '@/ws/handshake';
export type {
  HandshakeAccepted,
  HandshakeOptions,
  HandshakeRejected,
  HandshakeResult,
} from '@/ws/handshake';

export { WS_OPEN, createWsConnection } from '@/ws/connection';
export type {
  WsConnection,
  WsConnectionOptions,
  WsRateLimitOptions,
  WsSocket,
} from '@/ws/connection';

export { attachWebSocketServer } from '@/ws/ws.server';
export type { WsServerHandle, WsServerOptions } from '@/ws/ws.server';

export { handleClientFrame } from '@/ws/ws.protocol';
export type { ClientFrame, ServerFrame } from '@/ws/ws.protocol';

export { attachDomainWebSocketServer, wsAllowedOrigins } from '@/ws/ws.gateway';
