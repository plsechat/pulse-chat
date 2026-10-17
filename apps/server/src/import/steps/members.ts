import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { pushImportWarning } from '../../db/queries/import-jobs';
import { users } from '../../db/schema';
import type { TDiscordMember, TDiscordUser } from '../discord/types';
import { storeImportedFile } from '../files';
import { memberDisplayName, userAvatarUrl } from '../mapping';
import { addPlaceholderToServer, ensurePlaceholderUser } from '../placeholders';
import { IMPORT_PROVIDER, type ImportRun } from '../runner';

/** More than this is not a community an owner imports in one go. */
const MAX_MEMBERS = 50_000;
const PAGE_SIZE = 1000;
const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * Attribute a source user to one of ours: a real account that already
 * claimed the identity, an existing placeholder, or a new placeholder.
 * New placeholders get their avatar (best effort) and are fanned out
 * to the server's roster so messages by them render at once.
 */
const resolveImportedUser = async (
  run: ImportRun,
  user: TDiscordUser,
  nick: string | null | undefined,
  roleIds: number[]
): Promise<number> => {
  const cached = run.userCache.get(user.id);
  if (cached !== undefined) return cached;

  const avatarUrl = userAvatarUrl(user.id, user.avatar);
  const resolved = await ensurePlaceholderUser({
    provider: IMPORT_PROVIDER,
    externalId: user.id,
    displayName: memberDisplayName(user, nick),
    avatarUrl
  });

  await addPlaceholderToServer(run.serverId, resolved.userId, roleIds);

  if (resolved.created && avatarUrl && run.uploadsEnabled) {
    try {
      const bytes = await run.download(avatarUrl, MAX_AVATAR_BYTES);
      const file = await storeImportedFile(
        bytes,
        `avatar${user.avatar?.startsWith('a_') ? '.gif' : '.png'}`,
        resolved.userId
      );
      await db.update(users).set({ avatarId: file.id }).where(eq(users.id, resolved.userId));
    } catch (error) {
      run.error('members', memberDisplayName(user, nick), error);
    }
  }

  // A real account that claimed the identity before the import is a
  // member of the server now too; its roster entry refreshes the same way.
  void publishUser(resolved.userId, resolved.created ? 'create' : 'update', {
    scopeServerId: run.serverId
  });

  run.userCache.set(user.id, resolved.userId);

  return resolved.userId;
};

const mappedRoleIds = (run: ImportRun, roleIds: string[]): number[] =>
  roleIds
    .map((id) => run.state.map.roles[id])
    .filter((id): id is number => id !== undefined);

const runMembersStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('members');

  if (run.options.members !== 'everyone') {
    // 'posters' are minted as their messages arrive; 'nobody' never.
    counts.total = 0;
    return;
  }

  counts.total = run.state.estimates?.members ?? run.state.guild?.approximateMemberCount ?? null;
  if (run.state.cursor.members === 'done') return;
  let after = run.state.cursor.members ?? '0';

  for (;;) {
    const page = await run.client.get<TDiscordMember[]>(`/guilds/${run.guildId}/members`, {
      limit: PAGE_SIZE,
      after
    });
    if (!Array.isArray(page) || page.length === 0) break;

    for (const member of page) {
      const user = member.user;
      if (!user) continue;
      if (user.bot) {
        counts.skipped++;
        continue;
      }

      try {
        await resolveImportedUser(run, user, member.nick, mappedRoleIds(run, member.roles ?? []));
        counts.done++;
      } catch (error) {
        run.error('members', memberDisplayName(user, member.nick), error);
        counts.skipped++;
      }

      if (counts.done >= MAX_MEMBERS) {
        pushImportWarning(run.state, `Stopped after ${MAX_MEMBERS} members.`);
        run.state.cursor.members = 'done';
        return;
      }
    }

    after = page[page.length - 1]!.user?.id ?? after;
    run.state.cursor.members = after;
    await run.checkpoint();

    if (page.length < PAGE_SIZE) break;
  }

  run.state.cursor.members = 'done';
};

export { resolveImportedUser, runMembersStep };
