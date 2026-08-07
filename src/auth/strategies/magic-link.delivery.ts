import { AppError } from '@/lib/errors';

/** A link that has been minted and now has to reach its owner's inbox. */
export interface DeliverableMagicLink {
  email: string;
  /** The plaintext token. This is the only moment it exists outside the client. */
  token: string;
  /** Epoch milliseconds after which the link stops working. */
  expiresAt: number;
}

/**
 * How an issued link reaches the user.
 *
 * A port rather than an inlined `sendMail` because the transport is genuinely
 * deployment-specific — SES here, Postmark there, a queue somewhere else — and
 * because it is the one place in the flow that handles a *plaintext* token, so
 * it is worth being an explicit, reviewable seam rather than a detail buried in
 * the issuer.
 */
export interface MagicLinkDelivery {
  send(link: DeliverableMagicLink): Promise<void>;
}

export interface RecordingMagicLinkDelivery extends MagicLinkDelivery {
  /** The most recent link sent to an address, or `undefined` if there is none. */
  lastFor(email: string): DeliverableMagicLink | undefined;
  /** Forgets every recorded link. */
  clear(): void;
  readonly size: number;
}

export interface RecordingDeliveryOptions {
  /**
   * Where a delivered link is announced. Defaults to no logging, so tests do
   * not print tokens; the composition root passes a `console.info` writer for
   * local development, where seeing the link in the terminal is the point.
   */
  log?: (link: DeliverableMagicLink) => void;
  /** How many addresses to remember before evicting the least recently sent. */
  capacity?: number;
}

const DEFAULT_CAPACITY = 100;

/**
 * A delivery that keeps links in memory instead of sending mail.
 *
 * This exists for local development — where the alternative is wiring an SMTP
 * account before you can log in once — and for the end-to-end tests, which have
 * to read the token back to click the link. It is never wired in production;
 * see `createUnconfiguredMagicLinkDelivery`.
 *
 * Bounded on purpose: an unbounded `Map` keyed by attacker-supplied email
 * addresses on an endpoint that is deliberately reachable without credentials
 * is a memory-exhaustion bug, dev-only or not.
 */
export function createRecordingMagicLinkDelivery(
  options: RecordingDeliveryOptions = {},
): RecordingMagicLinkDelivery {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const log = options.log;

  // Insertion-ordered, and re-inserting on send moves an address to the back,
  // which makes `Map`'s own iteration order the LRU order for free.
  const byEmail = new Map<string, DeliverableMagicLink>();

  return {
    send(link: DeliverableMagicLink): Promise<void> {
      byEmail.delete(link.email);
      byEmail.set(link.email, link);

      while (byEmail.size > capacity) {
        const oldest = byEmail.keys().next();
        if (oldest.done === true) break;
        byEmail.delete(oldest.value);
      }

      log?.(link);
      return Promise.resolve();
    },

    lastFor(email: string): DeliverableMagicLink | undefined {
      return byEmail.get(email);
    },

    clear(): void {
      byEmail.clear();
    },

    get size(): number {
      return byEmail.size;
    },
  };
}

/**
 * The production default: fails loudly rather than pretending to send.
 *
 * A production deployment that has not wired a real sender has two options, and
 * both are worse than this. Falling back to the recording delivery would write
 * live credentials into the log stream. Silently succeeding would return 202 to
 * every request while no mail ever arrives, which looks like a broken mail
 * provider and can survive a long time before anyone reads it as a
 * misconfiguration.
 */
export function createUnconfiguredMagicLinkDelivery(): MagicLinkDelivery {
  return {
    send(): Promise<void> {
      return Promise.reject(
        new AppError(
          500,
          'Magic link delivery is not configured for this deployment',
          'MAGIC_LINK_DELIVERY_UNCONFIGURED',
        ),
      );
    },
  };
}

/**
 * Narrows a delivery to one whose links can be read back.
 *
 * The composition root exports the port type, because that is what callers
 * should depend on — but the E2E suite and local tooling genuinely need to
 * "open the inbox", and a type guard says so honestly where a cast would just
 * assert it. Returns false in production, where links are mailed.
 */
export function isRecordingMagicLinkDelivery(
  delivery: MagicLinkDelivery,
): delivery is RecordingMagicLinkDelivery {
  return typeof (delivery as Partial<RecordingMagicLinkDelivery>).lastFor === 'function';
}

/** Writes a delivered link to the process log. Development only. */
export function logMagicLink(link: DeliverableMagicLink): void {
  console.info(
    `[magic-link] ${link.email} → token=${link.token} (expires ${new Date(link.expiresAt).toISOString()})`,
  );
}
