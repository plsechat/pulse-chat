import { describe, expect, test } from 'bun:test';
import { BridgeStore, createMemoryStorage, MAX_MESSAGE_LINKS } from '../store';

const link = {
  channelId: 10,
  serverId: 1,
  remoteGuildId: '100000000000000001',
  remoteChannelId: '200000000000000001',
  webhookId: '910000000000000001',
  direction: 'both' as const
};

describe('bridge store', () => {
  test('message links are bounded: the oldest pair is evicted and both directions stay consistent', () => {
    const store = new BridgeStore(createMemoryStorage());

    for (let i = 1; i <= MAX_MESSAGE_LINKS + 5; i++) {
      store.setMessage({ localId: i, remoteId: `r${i}`, remoteChannelId: 'c', origin: 'in' }, false);
    }

    expect(store.messageCount).toBe(MAX_MESSAGE_LINKS);
    expect(store.messageByLocal(1)).toBeUndefined();
    expect(store.messageByRemote('r5')).toBeUndefined();
    expect(store.messageByRemote('r6')?.localId).toBe(6);
    expect(store.messageByLocal(MAX_MESSAGE_LINKS + 5)?.remoteId).toBe(`r${MAX_MESSAGE_LINKS + 5}`);
  });

  test('round-trips through storage and tolerates garbage or malformed rows', async () => {
    const storage = createMemoryStorage();
    const store = new BridgeStore(storage);
    store.setLink(link);
    store.setThread({ localThreadId: 50, remoteThreadId: 't1', channelId: 10, remoteChannelId: 'c' });
    store.setMessage({ localId: 1, remoteId: 'r1', remoteChannelId: 'c', origin: 'out' });
    store.setEvent({ localEventId: 2, remoteEventId: 'e1', remoteGuildId: 'g', origin: 'in' });
    store.rememberPersona('u1', { name: 'Carol', avatarUrl: 'https://cdn/x.png' });
    await store.flush();

    const saved = JSON.parse((await storage.load())!);
    expect(saved.links).toEqual([link]);
    expect(JSON.stringify(saved)).not.toContain('token');

    const reloaded = new BridgeStore(storage);
    await reloaded.load();
    expect(reloaded.links.get(10)).toEqual(link);
    expect(reloaded.threadByRemote('t1')?.localThreadId).toBe(50);
    expect(reloaded.messageByRemote('r1')?.origin).toBe('out');
    expect(reloaded.eventByRemote('e1')?.localEventId).toBe(2);
    expect(reloaded.personas.get('u1')?.name).toBe('Carol');

    const errors: string[] = [];
    const garbage = new BridgeStore(createMemoryStorage('{not json'), (m) => errors.push(m));
    await garbage.load();
    expect(errors[0]).toContain('not valid JSON');

    const malformed = new BridgeStore(
      createMemoryStorage(
        JSON.stringify({ links: [{ channelId: 'x' }, link], messages: [{ localId: 1 }], personas: 'no' })
      )
    );
    await malformed.load();
    expect([...malformed.links.values()]).toEqual([link]);
    expect(malformed.messageCount).toBe(0);
  });

  test('removing a link drops the threads under it; a persona is only re-saved when it changed', async () => {
    const storage = createMemoryStorage();
    const store = new BridgeStore(storage);
    store.setLink(link);
    store.setThread({ localThreadId: 50, remoteThreadId: 't1', channelId: 10, remoteChannelId: 'c' });
    store.setThread({ localThreadId: 51, remoteThreadId: 't2', channelId: 11, remoteChannelId: 'd' });

    expect(store.removeLink(10)).toEqual(link);
    expect(store.threadByRemote('t1')).toBeUndefined();
    expect(store.threadByRemote('t2')?.localThreadId).toBe(51);
    expect(store.removeLink(10)).toBeUndefined();

    await store.flush();
    store.rememberPersona('u1', { name: 'Carol' });
    await store.flush();
    const after = await storage.load();
    store.rememberPersona('u1', { name: 'Carol' });
    await store.flush();
    expect(await storage.load()).toBe(after);
  });

  test('a storage failure keeps the state dirty and reports instead of throwing', async () => {
    const errors: string[] = [];
    const store = new BridgeStore(
      {
        load: async () => null,
        save: async () => {
          throw new Error('disk full');
        }
      },
      (m) => errors.push(m)
    );
    store.setLink(link);
    await store.flush();
    expect(errors[0]).toContain('disk full');
  });
});
