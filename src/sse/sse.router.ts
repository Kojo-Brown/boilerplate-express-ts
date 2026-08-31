import { Router } from 'express';
import { requireAuth, requireRole } from '@/middleware/auth.middleware';
import { sseController } from '@/sse/sse.controller';

const sseRouter: Router = Router();

/**
 * Admin-only, and the reason is the payloads rather than the mechanism: this
 * stream carries `user.created` with the address that was registered and
 * `user.updated` with which fields moved, which is the audit log delivered live.
 * A stream anybody could open would be a subscription to everyone else's
 * activity.
 *
 * The classic middleware chain rather than `compose()`, unlike the routers
 * beside it. The pipeline exists to hand an operation a typed request and send
 * what it returns, and this handler returns nothing to send — it takes the
 * response over. Running it through `handle` would mean a `send` that must
 * never fire, which is a worse fit than two middlewares.
 *
 * **Bearer auth is deliberate, and it costs something worth stating.** The
 * browser's `EventSource` cannot set request headers at all, so a page cannot
 * open this URL directly; it needs a `fetch`-based client (or a polyfill) that
 * reads `response.body`. The alternative — accepting `?access_token=` — would
 * make the endpoint reachable from `new EventSource(url)` and would also write
 * a live credential into every access log, proxy log and `Referer` on the path.
 * `docs/server-sent-events.md` shows the `fetch` client.
 */
sseRouter.get('/stream', requireAuth, requireRole('admin'), sseController.stream);

export { sseRouter };
