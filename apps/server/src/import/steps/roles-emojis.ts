import { and, eq, max, sql } from 'drizzle-orm';
import { db } from '../../db';
import { publishEmoji, publishRole } from '../../db/publishers';
import { getUniqueEmojiName } from '../../db/queries/emojis';
import { pushImportWarning } from '../../db/queries/import-jobs';
import { getDefaultRoleForServer } from '../../db/queries/roles';
import { emojis, rolePermissions, roles } from '../../db/schema';
import type { TDiscordEmoji, TDiscordRole } from '../discord/types';
import { storeImportedFile } from '../files';
import {
  boundText,
  BOUNDS,
  colorIntToHex,
  emojiImageUrl,
  mapPermissionBits
} from '../mapping';
import type { ImportRun } from '../runner';

/** Source caps: 250 roles, 250 emoji per guild. */
const MAX_ROLES = 250;
const MAX_EMOJIS = 250;
const MAX_EMOJI_BYTES = 512 * 1024;
const CHECKPOINT_EVERY = 10;

// ─── roles ────────────────────────────────────────────────────────────

/**
 * Roles land between the default role and the owner role, in source
 * order (higher position = more senior there too); the owner role is
 * pushed up so it stays the highest. The source's @everyone role is
 * our default role: its mapped permissions are ADDED to the default
 * role, nothing is taken away from members.
 */
const runRolesStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('roles');

  if (run.options.roles === 'skip') {
    counts.total = 0;
    return;
  }

  const list = await run.client.get<TDiscordRole[]>(`/guilds/${run.guildId}/roles`);
  if (!Array.isArray(list)) return;
  if (list.length > MAX_ROLES) {
    pushImportWarning(run.state, `Only the first ${MAX_ROLES} roles were considered.`);
  }

  const everyone = list.find((r) => r.id === run.guildId);
  const importable = list
    .filter((r) => r.id !== run.guildId && !r.managed)
    .sort((a, b) => a.position - b.position)
    .slice(0, MAX_ROLES);
  counts.total = importable.length;

  for (const role of list) run.state.names.roles[role.id] = boundText(role.name, BOUNDS.roleName, 'role');

  if (everyone) {
    const defaultRole = await getDefaultRoleForServer(run.serverId);
    const granted = mapPermissionBits(everyone.permissions);
    if (defaultRole && granted.length > 0) {
      const now = run.now();
      await db
        .insert(rolePermissions)
        .values(granted.map((permission) => ({ roleId: defaultRole.id, permission, createdAt: now })))
        .onConflictDoNothing();
      void publishRole(defaultRole.id, 'update');
    }
  }

  const ownerRole = sql`(${roles.isPersistent} AND NOT ${roles.isDefault})`;
  const [row] = await db
    .select({ maxPos: max(roles.position) })
    .from(roles)
    .where(and(eq(roles.serverId, run.serverId), sql`NOT ${ownerRole}`));
  let position = (row?.maxPos ?? 0) + 1;

  for (const role of importable) {
    const name = run.state.names.roles[role.id]!;

    if (run.state.map.roles[role.id] !== undefined) {
      counts.done++;
      position++;
      continue;
    }

    try {
      const now = run.now();
      const granted = mapPermissionBits(role.permissions);

      const created = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(roles)
          .values({
            name,
            color: colorIntToHex(role.color),
            isDefault: false,
            isPersistent: false,
            serverId: run.serverId,
            position,
            createdAt: now
          })
          .returning({ id: roles.id });

        if (granted.length > 0) {
          await tx.insert(rolePermissions).values(
            granted.map((permission) => ({ roleId: inserted!.id, permission, createdAt: now }))
          );
        }

        return inserted!.id;
      });

      run.state.map.roles[role.id] = created;
      void publishRole(created, 'create');
      counts.done++;
      position++;
    } catch (error) {
      run.error('roles', name, error);
      counts.skipped++;
    }

    if ((counts.done + counts.skipped) % CHECKPOINT_EVERY === 0) await run.checkpoint();
  }

  // Pin the owner role directly above everything imported.
  const owner = await db
    .update(roles)
    .set({ position })
    .where(and(eq(roles.serverId, run.serverId), ownerRole))
    .returning({ id: roles.id });
  for (const { id } of owner) void publishRole(id, 'update');
};

// ─── emoji ────────────────────────────────────────────────────────────

const runEmojisStep = async (run: ImportRun): Promise<void> => {
  const counts = run.counts('emojis');
  const list = await run.client.get<TDiscordEmoji[]>(`/guilds/${run.guildId}/emojis`);
  if (!Array.isArray(list)) return;
  if (list.length > MAX_EMOJIS) {
    pushImportWarning(run.state, `Only the first ${MAX_EMOJIS} emoji were considered.`);
  }

  const importable = list
    .filter((e): e is TDiscordEmoji & { id: string; name: string } => !!e.id && !!e.name)
    .slice(0, MAX_EMOJIS);
  counts.total = importable.length;

  if (!run.uploadsEnabled) {
    counts.skipped = importable.length;
    pushImportWarning(run.state, 'File uploads are off on this server, so custom emoji were skipped.');
    return;
  }

  for (const emoji of importable) {
    if (run.state.map.emojis[emoji.id] !== undefined) {
      counts.done++;
      continue;
    }

    try {
      const ext = emoji.animated ? '.gif' : '.png';
      const bytes = await run.download(emojiImageUrl(emoji.id, emoji.animated), MAX_EMOJI_BYTES);
      const file = await storeImportedFile(bytes, `${emoji.name}${ext}`, run.actorId, ext);
      const name = await getUniqueEmojiName(boundText(emoji.name, BOUNDS.emojiName, 'emoji'));

      const [created] = await db
        .insert(emojis)
        .values({
          name,
          fileId: file.id,
          userId: run.actorId,
          serverId: run.serverId,
          createdAt: run.now()
        })
        .returning({ id: emojis.id });

      run.state.map.emojis[emoji.id] = { id: created!.id, name };
      void publishEmoji(created!.id, 'create');
      counts.done++;
    } catch (error) {
      run.error('emojis', `:${emoji.name}:`, error);
      counts.skipped++;
    }

    if ((counts.done + counts.skipped) % CHECKPOINT_EVERY === 0) await run.checkpoint();
  }
};

export { runEmojisStep, runRolesStep };
