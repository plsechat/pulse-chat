/**
 * The avatar placeholder gradient: one person, one gradient, everywhere.
 * Keyed on the publicId (numeric ids only when none is known), and
 * every surface that used to paint its own flat fallback now calls the
 * shared helper.
 *
 * Run via: bun test apps/client/src/components/user-avatar/__tests__/avatar-fallback.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { avatarFallbackClass, groupAvatarFallbackClass } from '../fallback';

const gradientOf = (cls: string) =>
  cls
    .split(' ')
    .filter((c) => c.startsWith('from-') || c.startsWith('to-'))
    .join(' ');

describe('avatarFallbackClass', () => {
  test('is deterministic for the same publicId', () => {
    const a = avatarFallbackClass({ id: 1, publicId: 'usr_8f3a1c' });
    const b = avatarFallbackClass({ id: 1, publicId: 'usr_8f3a1c' });
    expect(a).toBe(b);
    expect(a).toContain('bg-gradient-to-br');
    expect(a).toContain('text-white');
    expect(gradientOf(a)).toMatch(/^from-\S+ to-\S+$/);
  });

  test('the publicId wins over the per-instance numeric id', () => {
    // The same person carries different numeric ids on different
    // instances; the gradient must not change with them.
    expect(avatarFallbackClass({ id: 7, publicId: 'usr_8f3a1c' })).toBe(
      avatarFallbackClass({ id: 4321, publicId: 'usr_8f3a1c' })
    );
  });

  test('differs across ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      seen.add(gradientOf(avatarFallbackClass({ id: i, publicId: `usr_${i}` })));
    }
    // Eight gradients; a spread of ids must land on more than one.
    expect(seen.size).toBeGreaterThan(1);
    // Eight buckets, so two arbitrary ids may share one; these two are
    // known to land apart (hash32 buckets 0 and 4).
    expect(
      avatarFallbackClass({ id: 1, publicId: 'usr_charlie' })
    ).not.toBe(avatarFallbackClass({ id: 2, publicId: 'usr_delta' }));
  });

  test('falls back to the numeric id when no publicId is known', () => {
    const noId = avatarFallbackClass({ id: 42 });
    expect(noId).toBe(avatarFallbackClass({ id: 42, publicId: null }));
    expect(noId).toBe(avatarFallbackClass({ id: 42, publicId: '' }));
    expect(gradientOf(noId)).toMatch(/^from-\S+ to-\S+$/);
  });

  test('group icons are keyed on the conversation', () => {
    expect(groupAvatarFallbackClass(5)).toBe(groupAvatarFallbackClass(5));
    expect(groupAvatarFallbackClass(5)).toContain('bg-gradient-to-br');
  });
});

describe('every avatar surface renders the shared fallback', () => {
  const root = `${import.meta.dir}/../../..`;
  const sites = [
    'screens/home-view/home-sidebar.tsx',
    'screens/home-view/dm-conversation.tsx',
    'components/dialogs/group-dm-settings.tsx',
    'components/chat-primitives/message-reactions.tsx',
    'components/server-screens/channel-settings/permissions/overrides-list.tsx',
    'components/user-avatar/index.tsx'
  ];

  for (const site of sites) {
    test(site, async () => {
      const source = await Bun.file(`${root}/${site}`).text();
      expect(source).toMatch(/avatarFallbackClass|groupAvatarFallbackClass/);
      // No surface paints its own flat placeholder any more.
      expect(source).not.toMatch(/<AvatarFallback className="bg-muted/);
    });
  }
});
