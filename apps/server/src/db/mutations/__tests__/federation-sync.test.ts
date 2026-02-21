import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../..';
import { federationInstances, files, users } from '../../schema';
import { findOrCreateShadowUser, syncShadowUserProfile } from '../federation';
import { generateFederationKeys } from '../../../utils/federation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchAs = (fn: (...args: any[]) => Promise<Response>) =>
  fn as unknown as typeof fetch;

const originalFetch = globalThis.fetch;
const REMOTE_DOMAIN = 'remote.example.com';
const REMOTE_PUBLIC_ID = 'remote-user-pub-id-001';

let instanceId: number;
let shadowUserId: number;

// Tiny 1x1 PNG for mock file downloads
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);

function makeUserInfoResponse(opts?: {
  avatarName?: string | null;
  bannerName?: string | null;
  bio?: string | null;
  bannerColor?: string | null;
}) {
  return {
    name: 'Remote User',
    bio: opts?.bio ?? null,
    bannerColor: opts?.bannerColor ?? null,
    avatar: opts?.avatarName
      ? { id: 100, name: opts.avatarName, originalName: opts.avatarName, mimeType: 'image/png', size: 1024, extension: '.png' }
      : null,
    banner: opts?.bannerName
      ? { id: 200, name: opts.bannerName, originalName: opts.bannerName, mimeType: 'image/png', size: 2048, extension: '.png' }
      : null,
    createdAt: Date.now()
  };
}

beforeEach(async () => {
  await generateFederationKeys();

  const [instance] = await db
    .insert(federationInstances)
    .values({
      domain: REMOTE_DOMAIN,
      name: 'Remote Instance',
      status: 'active',
      direction: 'outgoing',
      createdAt: Date.now()
    })
    .returning();
  instanceId = instance!.id;

  const shadow = await findOrCreateShadowUser(
    instanceId, 42, 'RemoteUser', undefined, REMOTE_PUBLIC_ID
  );
  shadowUserId = shadow.id;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe('syncShadowUserProfile', () => {
  test('syncs avatar when shadow user has none', async () => {
    const profile = makeUserInfoResponse({ avatarName: 'remote-avatar.png' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) return Response.json(profile);
      if (urlStr.includes('/public/remote-avatar.png')) {
        return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
      }
      return originalFetch(url);
    }));
    const writeSpy = spyOn(Bun, 'write').mockResolvedValue(TINY_PNG.byteLength);

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    const [user] = await db.select({ avatarId: users.avatarId }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    expect(user!.avatarId).not.toBeNull();

    const [file] = await db.select().from(files).where(eq(files.id, user!.avatarId!)).limit(1);
    expect(file).toBeTruthy();
    expect(file!.name).toStartWith('federated-avatar-');
    expect(file!.originalName).toBe('remote-avatar.png');
    expect(file!.mimeType).toBe('image/png');
    writeSpy.mockRestore();
  });

  test('syncs banner when shadow user has none', async () => {
    const profile = makeUserInfoResponse({ bannerName: 'remote-banner.png' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) return Response.json(profile);
      if (urlStr.includes('/public/remote-banner.png')) {
        return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
      }
      return originalFetch(url);
    }));
    const writeSpy = spyOn(Bun, 'write').mockResolvedValue(TINY_PNG.byteLength);

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    const [user] = await db.select({ bannerId: users.bannerId }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    expect(user!.bannerId).not.toBeNull();

    const [file] = await db.select().from(files).where(eq(files.id, user!.bannerId!)).limit(1);
    expect(file).toBeTruthy();
    expect(file!.name).toStartWith('federated-banner-');
    writeSpy.mockRestore();
  });

  test('syncs bio and bannerColor', async () => {
    const profile = makeUserInfoResponse({ bio: 'Hello from remote!', bannerColor: '#ff5500' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) return Response.json(profile);
      return originalFetch(url);
    }));

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    const [user] = await db.select({ bio: users.bio, bannerColor: users.bannerColor }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    expect(user!.bio).toBe('Hello from remote!');
    expect(user!.bannerColor).toBe('#ff5500');
  });

  test('updates avatar when remote has changed', async () => {
    const profile1 = makeUserInfoResponse({ avatarName: 'old-avatar.png' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) return Response.json(profile1);
      if (urlStr.includes('/public/')) {
        return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
      }
      return originalFetch(url);
    }));
    const writeSpy = spyOn(Bun, 'write').mockResolvedValue(TINY_PNG.byteLength);

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    const [userBefore] = await db.select({ avatarId: users.avatarId }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    const oldAvatarId = userBefore!.avatarId;
    expect(oldAvatarId).not.toBeNull();

    // Clear debounce
    await db.update(users).set({ updatedAt: Date.now() - 10 * 60 * 1000 })
      .where(eq(users.id, shadowUserId));

    const profile2 = makeUserInfoResponse({ avatarName: 'new-avatar.png' });
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) return Response.json(profile2);
      if (urlStr.includes('/public/')) {
        return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
      }
      return originalFetch(url);
    }));

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    const [userAfter] = await db.select({ avatarId: users.avatarId }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    expect(userAfter!.avatarId).not.toBeNull();
    expect(userAfter!.avatarId).not.toBe(oldAvatarId);
    writeSpy.mockRestore();
  });

  test('respects debounce — skips sync if recently updated', async () => {
    await db.update(users).set({ updatedAt: Date.now() }).where(eq(users.id, shadowUserId));

    let fetchCalled = false;
    globalThis.fetch = mockFetchAs(mock(async () => {
      fetchCalled = true;
      return new Response('should not be called', { status: 500 });
    }));

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    expect(fetchCalled).toBe(false);
  });

  test('handles HTTP error gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return originalFetch(url);
    }));

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    const [user] = await db.select({ avatarId: users.avatarId, bio: users.bio }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    expect(user!.avatarId).toBeNull();
    expect(user!.bio).toBeNull();
  });

  test('skips avatar download when unchanged', async () => {
    const profile = makeUserInfoResponse({ avatarName: 'same-avatar.png' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) return Response.json(profile);
      if (urlStr.includes('/public/')) {
        return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
      }
      return originalFetch(url);
    }));
    const writeSpy = spyOn(Bun, 'write').mockResolvedValue(TINY_PNG.byteLength);

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    const [userBefore] = await db.select({ avatarId: users.avatarId }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    expect(userBefore!.avatarId).not.toBeNull();

    // Clear debounce
    await db.update(users).set({ updatedAt: Date.now() - 10 * 60 * 1000 })
      .where(eq(users.id, shadowUserId));

    let fileDownloadCalled = false;
    globalThis.fetch = mockFetchAs(mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/federation/user-info')) return Response.json(profile);
      if (urlStr.includes('/public/')) {
        fileDownloadCalled = true;
        return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
      }
      return originalFetch(url);
    }));

    await syncShadowUserProfile(shadowUserId, REMOTE_DOMAIN, REMOTE_PUBLIC_ID);

    expect(fileDownloadCalled).toBe(false);

    const [userAfter] = await db.select({ avatarId: users.avatarId }).from(users)
      .where(eq(users.id, shadowUserId)).limit(1);
    expect(userAfter!.avatarId).toBe(userBefore!.avatarId);
    writeSpy.mockRestore();
  });
});
