import {
  createRecordingMagicLinkDelivery,
  createUnconfiguredMagicLinkDelivery,
  isRecordingMagicLinkDelivery,
  logMagicLink,
} from '@/auth/strategies/magic-link.delivery';
import type { DeliverableMagicLink } from '@/auth/strategies/magic-link.delivery';

function link(email: string, token = 'mock-magic-token'): DeliverableMagicLink {
  return { email, token, expiresAt: 1_700_000_000_000 };
}

describe('createRecordingMagicLinkDelivery', () => {
  it('records the link it was handed', async () => {
    const delivery = createRecordingMagicLinkDelivery();
    await delivery.send(link('user@example.com'));

    expect(delivery.lastFor('user@example.com')).toEqual(link('user@example.com'));
  });

  it('returns undefined for an address it never delivered to', () => {
    const delivery = createRecordingMagicLinkDelivery();

    expect(delivery.lastFor('nobody@example.com')).toBeUndefined();
  });

  it('keeps only the most recent link per address', async () => {
    const delivery = createRecordingMagicLinkDelivery();
    await delivery.send(link('user@example.com', 'first'));
    await delivery.send(link('user@example.com', 'second'));

    expect(delivery.lastFor('user@example.com')?.token).toBe('second');
    expect(delivery.size).toBe(1);
  });

  it('evicts the least recently sent address once capacity is exceeded', async () => {
    const delivery = createRecordingMagicLinkDelivery({ capacity: 2 });

    await delivery.send(link('a@example.com'));
    await delivery.send(link('b@example.com'));
    await delivery.send(link('c@example.com'));

    expect(delivery.size).toBe(2);
    expect(delivery.lastFor('a@example.com')).toBeUndefined();
    expect(delivery.lastFor('c@example.com')).toBeDefined();
  });

  it('treats a resend as recent use, so it is not the next eviction', async () => {
    const delivery = createRecordingMagicLinkDelivery({ capacity: 2 });

    await delivery.send(link('a@example.com'));
    await delivery.send(link('b@example.com'));
    await delivery.send(link('a@example.com', 'refreshed'));
    await delivery.send(link('c@example.com'));

    expect(delivery.lastFor('a@example.com')?.token).toBe('refreshed');
    expect(delivery.lastFor('b@example.com')).toBeUndefined();
  });

  it('does not log unless a writer is supplied', async () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await createRecordingMagicLinkDelivery().send(link('user@example.com'));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('calls the injected writer with the delivered link', async () => {
    const log = jest.fn();
    await createRecordingMagicLinkDelivery({ log }).send(link('user@example.com'));

    expect(log).toHaveBeenCalledWith(link('user@example.com'));
  });

  it('clears every recorded link', async () => {
    const delivery = createRecordingMagicLinkDelivery();
    await delivery.send(link('a@example.com'));

    delivery.clear();

    expect(delivery.size).toBe(0);
    expect(delivery.lastFor('a@example.com')).toBeUndefined();
  });
});

describe('createUnconfiguredMagicLinkDelivery', () => {
  it('fails with a 500 rather than pretending to send', async () => {
    await expect(
      createUnconfiguredMagicLinkDelivery().send(link('user@example.com')),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'MAGIC_LINK_DELIVERY_UNCONFIGURED',
    });
  });
});

describe('isRecordingMagicLinkDelivery', () => {
  it('recognises a recording delivery', () => {
    expect(isRecordingMagicLinkDelivery(createRecordingMagicLinkDelivery())).toBe(true);
  });

  it('rejects the production delivery', () => {
    expect(isRecordingMagicLinkDelivery(createUnconfiguredMagicLinkDelivery())).toBe(false);
  });

  it('rejects an arbitrary sender that only implements the port', () => {
    expect(isRecordingMagicLinkDelivery({ send: () => Promise.resolve() })).toBe(false);
  });
});

describe('logMagicLink', () => {
  it('writes the address, token and expiry to the process log', () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      logMagicLink(link('user@example.com', 'mock-token-value'));

      expect(spy).toHaveBeenCalledTimes(1);
      const [message] = spy.mock.calls[0] as [string];
      expect(message).toContain('user@example.com');
      expect(message).toContain('mock-token-value');
      expect(message).toContain(new Date(1_700_000_000_000).toISOString());
    } finally {
      spy.mockRestore();
    }
  });
});
