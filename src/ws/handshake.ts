import type { IncomingMessage } from 'node:http';
import { verifyAccessToken } from '@/lib/jwt';
import { AppError } from '@/lib/errors';
import type { JwtPayload } from '@/auth/auth.types';

/**
 * Who is opening this socket, decided from the upgrade request alone.
 *
 * Everything here is a pure function of an `IncomingMessage`, which is what
 * lets the whole authentication story be tested without a server, a port, or a
 * client. `ws.server.ts` is the only file that turns a verdict into bytes.
 *
 * The decision happens at the *handshake* and not after the socket is open, and
 * that is the load-bearing choice in this module. An "authenticate by sending a
 * token as your first message" design — which is common, because it dodges the
 * browser problem below — means the server accepts, allocates and tracks a
 * connection for every unauthenticated peer that asks, and then has to invent a
 * timeout for the ones that never send anything. Refusing during the upgrade
 * costs nothing and answers with an HTTP status a proxy, a log and a human all
 * already understand.
 */

/**
 * The subprotocol that carries a bearer token from a browser.
 *
 * The problem it solves: the browser `WebSocket` constructor takes a URL and a
 * subprotocol list and nothing else. There is no headers argument, so
 * `Authorization: Bearer …` — the way every other route here is authenticated
 * — is simply not reachable from a browser. The two things people do instead
 * are a `?token=` query parameter and a cookie, and both are worse:
 *
 *   - A query parameter is written to every access log, proxy log and APM trace
 *     on the path, and lands in `Referer` on any navigation from the page. It
 *     is a bearer credential in plain text in ten systems that were never meant
 *     to hold one, and rotating it means rotating them.
 *   - A cookie is sent automatically, which is exactly the problem: a WebSocket
 *     handshake is *not* subject to the same-origin policy and CORS does not
 *     apply to it, so any page on the internet can open an authenticated socket
 *     to this service in a logged-in user's browser. That is cross-site
 *     WebSocket hijacking, and cookie auth is what makes it possible.
 *
 * The subprotocol list is a request header the browser *will* set, and it is
 * echoed back by the server rather than logged as a URL. The token is the
 * second entry; the first is this sentinel, which is what the server selects
 * and returns in `Sec-WebSocket-Protocol`. Selecting the sentinel and never the
 * token matters: the response header is the negotiated protocol name, and
 * echoing the credential back would put it in the response for anything logging
 * headers to pick up.
 *
 *     new WebSocket(url, ['bearer.auth.v1', accessToken])
 *
 * The remaining caveat is honest rather than fixable here: the token is in a
 * header, so it is not in a URL, but it is still readable by any script running
 * on the page. That is the same exposure the REST client has and is a property
 * of holding a bearer token in a browser at all.
 */
export const BEARER_SUBPROTOCOL = 'bearer.auth.v1';

export interface HandshakeAccepted {
  readonly ok: true;
  readonly principal: JwtPayload;
  /**
   * The subprotocol to echo in the response, or `undefined` when the client
   * offered none.
   *
   * Not optional-by-omission at the call site: RFC 6455 §4.2.2 makes echoing a
   * protocol the client did not offer a handshake failure, and browsers enforce
   * it by closing the connection immediately with no useful error. Returning it
   * from the same function that read the request is what keeps the two in step.
   */
  readonly subprotocol: string | undefined;
}

export interface HandshakeRejected {
  readonly ok: false;
  /** The HTTP status written to the socket before it is destroyed. */
  readonly status: number;
  /** Machine-readable, and the same vocabulary the REST error envelope uses. */
  readonly code: string;
  readonly message: string;
}

export type HandshakeResult = HandshakeAccepted | HandshakeRejected;

export interface HandshakeOptions {
  /**
   * Origins a browser may open a socket from, or `null` to accept any.
   *
   * Worth being precise about what this buys, because it is easy to over- or
   * under-sell. A WebSocket handshake ignores the same-origin policy: a browser
   * will open one cross-origin without a preflight, and no CORS header on the
   * response can prevent it. `Origin` is therefore the *only* signal the server
   * has about which page initiated a browser connection, and checking it is
   * what stops an attacker's page from opening sockets in a victim's browser.
   *
   * With bearer-token auth that attack already fails — the attacker's page
   * cannot read the token out of the victim's origin, so it cannot complete the
   * handshake — so this is defence in depth against the credential model
   * changing later, and against a token that leaked to a page it should not
   * have. It is not the primary control and is not treated as one.
   *
   * A request with no `Origin` is allowed: only browsers send the header, and
   * only browsers can be made to attack. Refusing them would lock out every
   * server-to-server client for no security gain.
   */
  readonly allowedOrigins: readonly string[] | null;
}

/**
 * Reads the bearer token out of an upgrade request.
 *
 * `Authorization` first, so a non-browser client uses the same header it uses
 * for every REST call and does not have to know about the subprotocol at all.
 */
export function readHandshakeToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();
    if (token.length > 0) return token;
  }

  const offered = readOfferedSubprotocols(req);
  const sentinel = offered.indexOf(BEARER_SUBPROTOCOL);
  if (sentinel === -1) return undefined;

  return offered[sentinel + 1];
}

/**
 * `Sec-WebSocket-Protocol` as a list.
 *
 * The header may appear more than once, in which case Node joins the values
 * with `, ` — the same separator used within one value — so splitting the
 * joined string is correct for both shapes and is why this does not branch on
 * `Array.isArray`.
 */
export function readOfferedSubprotocols(req: IncomingMessage): string[] {
  const header = req.headers['sec-websocket-protocol'];
  if (header === undefined) return [];

  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * The whole handshake decision: token, principal, origin.
 *
 * Returns a verdict rather than throwing, because the two outcomes are written
 * to the socket in completely different ways — one continues into
 * `handleUpgrade`, the other writes a raw HTTP response — and a `try`/`catch`
 * around a call that is expected to fail on ordinary input reads as an error
 * path when it is a normal one.
 */
export function authenticateHandshake(
  req: IncomingMessage,
  options: HandshakeOptions,
): HandshakeResult {
  const origin = req.headers.origin;
  if (options.allowedOrigins !== null && origin !== undefined) {
    if (!options.allowedOrigins.includes(origin)) {
      // 403 rather than 401: this is not a credential the client can fix by
      // presenting a better one.
      return {
        ok: false,
        status: 403,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'WebSocket connections are not accepted from this origin',
      };
    }
  }

  const token = readHandshakeToken(req);
  if (token === undefined) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: `Missing access token. Send an Authorization: Bearer header, or offer the "${BEARER_SUBPROTOCOL}" subprotocol followed by the token.`,
    };
  }

  let principal: JwtPayload;
  try {
    principal = verifyAccessToken(token);
  } catch (err) {
    // `verifyAccessToken` throws `AppError(401, …, 'TOKEN_INVALID')` and
    // nothing else, but a signature-verification helper is exactly the place a
    // future change could start throwing something else, and an unexpected
    // throw here would take down the `upgrade` listener rather than refusing
    // one socket.
    const code = err instanceof AppError && err.code !== undefined ? err.code : 'TOKEN_INVALID';
    return {
      ok: false,
      status: 401,
      code,
      message: 'Invalid or expired access token',
    };
  }

  // Belt and braces: a refresh token is signed with a different secret and
  // already fails verification above. This catches the deployment that sets
  // both secrets to the same value — a configuration mistake, not an attack,
  // and one that would otherwise silently let a seven-day credential open a
  // socket that a fifteen-minute one was meant to.
  if (principal.type !== 'access') {
    return {
      ok: false,
      status: 401,
      code: 'TOKEN_INVALID',
      message: 'Invalid or expired access token',
    };
  }

  return {
    ok: true,
    principal,
    subprotocol: readOfferedSubprotocols(req).includes(BEARER_SUBPROTOCOL)
      ? BEARER_SUBPROTOCOL
      : undefined,
  };
}

/**
 * Milliseconds until `principal` expires, or `undefined` for a token with no `exp`.
 *
 * Here rather than in the connection because it is the handshake's fact: the
 * credential was checked once, at this instant, and on a socket that is the
 * *only* time it is ever checked. See `WsConnectionOptions.expiresInMs`.
 */
export function millisecondsUntilExpiry(principal: JwtPayload, nowMs: number = Date.now()): number | undefined {
  if (principal.exp === undefined) return undefined;
  // `exp` is seconds since the epoch (RFC 7519 §4.1.4), not milliseconds.
  return Math.max(0, principal.exp * 1000 - nowMs);
}
