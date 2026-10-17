import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { createTestRole, createTestServer, grantTestUserRole } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  getImportJob,
  readImportState,
  setImportJobOptions,
  transitionImportJob
} from '../../db/queries/import-jobs';
import {
  categories,
  channels,
  emojis,
  events,
  externalIdentities,
  files,
  importJobs,
  messageFiles,
  messages,
  pluginMessageLinks,
  rolePermissions,
  roles,
  serverMembers,
  servers,
  userRoles,
  users
} from '../../db/schema';
import {
  createFixtureDownloader,
  createFixtureTransport,
  nightRaiders,
  type TFixture
} from '../../import/__tests__/fixture-transport';
import { setImportDepsForTests } from '../../import/control';
import { timestampToSnowflake } from '../../import/mapping';
import { claimExternalIdentity, providerIdentityFromAuth } from '../../import/placeholders';
import { runImportJob } from '../../import/runner';
import { IMPORT_LINK_PLUGIN_ID } from '../../import/steps/messages';
import { encryptImportToken } from '../../import/token-crypto';
import { importQueue } from '../../queues/import';
import { drainQueue } from '../../queues/drain';
import { pubsub } from '../../utils/pubsub';

/**
 * The community import end to end: the owner-only routes, a full run
 * against the recorded guild (every entity kind, content mapping,
 * attachments, pins, threads, replies, events), the option matrix,
 * resume after a failure, pause/cancel, progress events, the token's
 * life cycle, and the placeholder claim. The API is the replayed
 * fixture; the CDN is an in-memory stub. No network anywhere.
 */

const fixture = nightRaiders as unknown as TFixture;
const ids = fixture.ids;
const SERVER_ID = 1;
const OWNER_ID = 1;
const MEMBER_ID = 2;
const FIXED_NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

type TOptions = { history: 'all' | 'last30days' | 'last1000' | 'none'; attachments: 'download' | 'skip'; members: 'posters' | 'everyone' | 'nobody'; roles: 'import' | 'skip' };
const ALL: TOptions = { history: 'all', attachments: 'download', members: 'everyone', roles: 'import' };

const tdb = () => getTestDb();

/** Wire the replayed API + stub CDN into the production code paths. */
const useFixture = (options: Parameters<typeof createFixtureTransport>[0] = {}) => {
  const api = createFixtureTransport(options);
  const cdn = createFixtureDownloader();
  setImportDepsForTests({
    transport: api.transport,
    download: cdn.download,
    sleep: async () => undefined,
    now: () => FIXED_NOW
  });
  return { ...api, ...cdn };
};

afterEach(() => {
  setImportDepsForTests({});
  mock.restore();
});

/** Connect + pick + preview through the routes; returns the pending job. */
const connectAndPreview = async (caller: Awaited<ReturnType<typeof initTest>>['caller'], token: string) => {
  const job = await caller.import.createJob({ serverId: SERVER_ID, token });
  const preview = await caller.import.preview({ serverId: SERVER_ID, jobId: job.id, guildId: ids.guild! });
  return { job, preview };
};

/** Options + run synchronously (the route's enqueue is tested on its own). */
const runWith = async (jobId: number, options: TOptions) => {
  await setImportJobOptions(jobId, { ...options, guildId: ids.guild! });
  const started = await transitionImportJob(jobId, { from: ['pending', 'failed'], to: 'running', step: 'guild' });
  expect(started).toBeDefined();
  return runImportJob(jobId);
};

const channelByName = async (name: string) => {
  const [row] = await tdb().select().from(channels).where(and(eq(channels.serverId, SERVER_ID), eq(channels.name, name)));
  return row;
};

const messagesIn = async (channelId: number) =>
  tdb().select().from(messages).where(eq(messages.channelId, channelId)).orderBy(asc(messages.createdAt));

const identityFor = async (externalId: string) => {
  const [row] = await tdb()
    .select()
    .from(externalIdentities)
    .where(and(eq(externalIdentities.provider, 'discord'), eq(externalIdentities.externalId, externalId)));
  return row;
};

describe('import.createJob (connect)', () => {
  test('rejects a token that is not token-shaped without calling the API', async () => {
    const { calls } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    await expect(caller.import.createJob({ serverId: SERVER_ID, token: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(calls).toHaveLength(0);
  });

  test('a wrong token is checked with one call and refused plainly', async () => {
    const { calls } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    await expect(
      caller.import.createJob({ serverId: SERVER_ID, token: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.wrong1.mnopqrstuvwxyz0123456789' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining("didn't work") });
    expect(calls.map((c) => c.path)).toEqual(['/users/@me']);
    expect(await tdb().select().from(importJobs)).toHaveLength(0);
  });

  test('stores the token encrypted, exposes the bot only, and allows one job per server', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);

    const job = await caller.import.createJob({ serverId: SERVER_ID, token });
    expect(job).toMatchObject({ status: 'pending', bot: { id: ids.bot, name: 'pulse-import' }, guild: null });
    expect(JSON.stringify(job)).not.toContain(token);
    expect('tokenCiphertext' in job).toBe(false);

    const [row] = await tdb().select().from(importJobs).where(eq(importJobs.id, job.id));
    expect(row!.tokenCiphertext).toBeDefined();
    expect(row!.tokenCiphertext).not.toContain(token);
    expect(row!.tokenCiphertext!.startsWith('v1.')).toBe(true);

    await expect(caller.import.createJob({ serverId: SERVER_ID, token })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await caller.import.getCurrent({ serverId: SERVER_ID })).toMatchObject({ id: job.id, status: 'pending' });
  });

  test('is the server owner\'s alone — a MANAGE_SETTINGS holder is refused', async () => {
    const { token } = useFixture();
    const roleId = await createTestRole({ serverId: SERVER_ID, permissions: [Permission.MANAGE_SETTINGS] });
    await grantTestUserRole(MEMBER_ID, roleId);
    const { caller } = await initTest(MEMBER_ID);
    await expect(caller.import.createJob({ serverId: SERVER_ID, token })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.import.getCurrent({ serverId: SERVER_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.import.getBotInstallUrl({ serverId: SERVER_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('getBotInstallUrl names the two permissions and the two intents, with the exact permission bits', async () => {
    useFixture();
    const { caller } = await initTest(OWNER_ID);
    const bare = await caller.import.getBotInstallUrl({ serverId: SERVER_ID });
    expect(bare.url).toBeNull();
    expect(bare.permissions.map((p) => p.name)).toEqual(['View channels', 'Read message history']);
    expect(bare.intents.map((p) => p.name)).toEqual(['Server Members Intent', 'Message Content Intent']);

    const linked = await caller.import.getBotInstallUrl({ serverId: SERVER_ID, applicationId: ids.bot });
    expect(linked.url).toBe(`https://discord.com/oauth2/authorize?client_id=${ids.bot}&scope=bot&permissions=66560`);
  });
});

describe('import.listGuilds / preview', () => {
  test('lists the guilds the bot is in and previews the chosen one', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const job = await caller.import.createJob({ serverId: SERVER_ID, token });

    const guilds = await caller.import.listGuilds({ serverId: SERVER_ID, jobId: job.id });
    expect(guilds).toEqual([
      expect.objectContaining({ id: ids.guild, name: 'Night Raiders', approximateMemberCount: 4, iconUrl: expect.stringContaining('cdn.discordapp.com/icons/') }),
      expect.objectContaining({ id: '900000000000000002', name: 'Other Place', iconUrl: null })
    ]);

    const preview = await caller.import.preview({ serverId: SERVER_ID, jobId: job.id, guildId: ids.guild! });
    expect(preview.guild.name).toBe('Night Raiders');
    expect(preview.counts).toMatchObject({
      categories: 2,
      channels: { text: 4, voice: 1, forum: 1, skipped: 1 },
      roles: 2,
      emojis: 2,
      members: 4,
      threads: 2,
      scheduledEvents: 1
    });
    expect(preview.counts.estimatedMessages).toBeGreaterThan(0);
    // Every recorded channel fits in one page, so the estimate is a count
    // bounded by what the guild holds — never the lifetime extrapolation
    // that once put a small community at hundreds of thousands.
    const recorded = Object.values(fixture.messages).reduce((n, list) => n + list.length, 0);
    expect(preview.counts.estimatedMessages).toBeLessThanOrEqual(recorded);
    expect(preview.estimateByDepth.none).toBe(0);
    expect(preview.estimateByDepth.last1000).toBeLessThanOrEqual(preview.estimateByDepth.all);
    expect(preview.estimatedSeconds).toBeGreaterThan(0);
    expect(preview.unreadableChannels).toEqual(['officers-only']);
    expect(preview.warnings.some((w) => w.includes('cannot read 1 channel'))).toBe(true);

    // The pick is remembered on the job for a reopened wizard.
    expect(await caller.import.getCurrent({ serverId: SERVER_ID })).toMatchObject({ guild: { id: ids.guild, name: 'Night Raiders' } });
  });

  test('a job of another server reads as not found', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const job = await caller.import.createJob({ serverId: SERVER_ID, token });
    const other = await createTestServer({ ownerId: OWNER_ID });
    await expect(caller.import.listGuilds({ serverId: other, jobId: job.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller.import.pause({ serverId: other, jobId: job.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a full run', () => {
  test('brings every entity kind across, maps content, and ends with the token erased', async () => {
    const { token, downloads } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    const publishSpy = spyOn(pubsub, 'publishFor');

    expect(await runWith(job.id, ALL)).toBe('done');

    const final = (await getImportJob(job.id))!;
    expect(final.status).toBe('done');
    expect(final.tokenCiphertext).toBeNull();
    expect(final.error).toBeNull();
    const state = readImportState(final);
    expect(state.stepsDone).toEqual(['guild', 'categories', 'channels', 'roles', 'emojis', 'members', 'pins', 'threads', 'messages', 'events']);

    // guild → server fields + icon
    const [server] = await tdb().select().from(servers).where(eq(servers.id, SERVER_ID));
    expect(server!.name).toBe('Night Raiders');
    expect(server!.description).toBe('We raid at night.');
    expect(server!.logoId).not.toBeNull();
    expect(downloads.some((d) => d.url.includes('/icons/'))).toBe(true);

    // categories: the two from the source + one for the uncategorised channel
    const cats = await tdb().select().from(categories).where(eq(categories.serverId, SERVER_ID)).orderBy(asc(categories.position));
    expect(cats.map((c) => c.name)).toEqual(['Text Channels', 'Voice Channels', 'Text', 'Voice', 'Channels']);

    // channels: kinds, topic, order, bounded name, unsupported skipped
    const general = (await channelByName('general'))!;
    expect(general).toMatchObject({ type: ChannelType.TEXT, topic: 'Talk about anything', position: 0 });
    expect((await channelByName('news'))!).toMatchObject({ type: ChannelType.TEXT, position: 1 });
    expect((await channelByName('Lounge'))!.type).toBe(ChannelType.VOICE);
    expect((await channelByName('guides'))!.type).toBe(ChannelType.FORUM);
    const orphan = (await channelByName('a-very-long-channel-name'))!;
    expect(orphan.categoryId).toBe(cats[4]!.id);
    expect(await channelByName('mystery')).toBeUndefined();
    expect(state.counts.channels).toMatchObject({ done: 6, skipped: 1 });
    expect(state.warnings.some((w) => w.includes('#officers-only'))).toBe(true);

    // roles: colours, mapped bits, order under the owner role, managed skipped, @everyone → default
    const serverRoles = await tdb().select().from(roles).where(eq(roles.serverId, SERVER_ID)).orderBy(asc(roles.position));
    const raider = serverRoles.find((r) => r.name === 'Raider')!;
    const officer = serverRoles.find((r) => r.name === 'Officer')!;
    const owner = serverRoles.find((r) => r.isPersistent && !r.isDefault)!;
    expect(raider.color).toBe('#ff0000');
    expect(officer.position).toBe(raider.position + 1);
    expect(owner.position).toBeGreaterThan(officer.position);
    expect(serverRoles.find((r) => r.name === 'Some Bot')).toBeUndefined();
    const raiderPerms = (await tdb().select().from(rolePermissions).where(eq(rolePermissions.roleId, raider.id))).map((p) => p.permission).sort();
    expect(raiderPerms).toEqual([Permission.MANAGE_MESSAGES, Permission.PIN_MESSAGES, Permission.SEND_MESSAGES, Permission.UPLOAD_FILES].sort());
    expect(await tdb().select().from(rolePermissions).where(eq(rolePermissions.roleId, officer.id))).toHaveLength(Object.values(Permission).length);
    const defaultRole = serverRoles.find((r) => r.isDefault)!;
    const defaultPerms = (await tdb().select().from(rolePermissions).where(eq(rolePermissions.roleId, defaultRole.id))).map((p) => p.permission);
    expect(defaultPerms).toContain(Permission.MANAGE_INVITES);

    // emoji: two files, unique names
    const serverEmojis = await tdb().select().from(emojis).where(eq(emojis.serverId, SERVER_ID));
    expect(serverEmojis.map((e) => e.name).sort()).toEqual(['dance', 'pog']);
    expect(downloads.filter((d) => d.url.includes('/emojis/')).map((d) => d.url)).toEqual([
      `https://cdn.discordapp.com/emojis/${ids.emojiPog}.png?size=128`,
      `https://cdn.discordapp.com/emojis/${ids.emojiDance}.gif?size=128`
    ]);

    // members: placeholders (not the bot), memberships, roles, avatar, display names
    const alice = (await identityFor(ids.alice!))!;
    const bob = (await identityFor(ids.bob!))!;
    const dave = (await identityFor(ids.dave!))!;
    expect(await identityFor(ids.bot!)).toBeUndefined();
    expect(alice.placeholder).toBe(true);
    const [aliceUser] = await tdb().select().from(users).where(eq(users.id, alice.userId));
    expect(aliceUser!.name).toBe('Alice');
    expect(aliceUser!.supabaseId).toBe(`placeholder:discord:${ids.alice}`);
    expect(aliceUser!.avatarId).not.toBeNull();
    const [bobUser] = await tdb().select().from(users).where(eq(users.id, bob.userId));
    expect(bobUser!.name).toBe('Bobby');
    const memberRows = await tdb().select().from(serverMembers).where(and(eq(serverMembers.serverId, SERVER_ID), inArray(serverMembers.userId, [alice.userId, bob.userId, dave.userId])));
    expect(memberRows).toHaveLength(3);
    const daveRoles = (await tdb().select().from(userRoles).where(eq(userRoles.userId, dave.userId))).map((r) => r.roleId).sort();
    expect(daveRoles).toEqual([raider.id, officer.id].sort());
    expect(state.counts.members).toMatchObject({ done: 3, skipped: 1 });

    // messages in #general: order, content mapping, reply, pin, attachment, thread starter, skipped system row
    const pog = serverEmojis.find((e) => e.name === 'pog')!;
    const generalMessages = await messagesIn(general.id);
    expect(generalMessages).toHaveLength(5);
    const [m1, m2, m4, m5, m6] = generalMessages;
    expect(m1!.userId).toBe(alice.userId);
    expect(m1!.content).toBe(`hello <@${bob.userId}> <:pog:${pog.id}> look at #news and :unknown:`);
    expect(m1!.createdAt).toBe(Date.parse('2023-01-10T12:00:00.000Z'));
    const m1Files = await tdb().select().from(messageFiles).where(eq(messageFiles.messageId, m1!.id));
    expect(m1Files).toHaveLength(1);
    const [stored] = await tdb().select().from(files).where(eq(files.id, m1Files[0]!.fileId));
    expect(stored!.originalName).toBe('map.png');
    expect(stored!.userId).toBe(OWNER_ID);
    expect(m2!).toMatchObject({ userId: bob.userId, replyToId: m1!.id, pinned: true, pinnedBy: OWNER_ID, edited: true });
    expect(m2!.content).toBe(`hi <@&${raider.id}> and @Some Bot`);
    expect(m4!.content).toBe('Patch notes — https://example.com/notes');
    expect((await identityFor('600000000000000001'))!.userId).toBe(m4!.userId);
    expect(m5!.content).toBe('late 2023-11-14 22:13 @everyone\n:wave:');
    const carol = (await identityFor(ids.carol!))!;
    expect(m5!.userId).toBe(carol.userId);
    expect(generalMessages.every((m) => !m.mentionsAll && m.mentionedUserIds === null)).toBe(true);

    // threads: active, archived, forum post; starter linked
    const help = (await channelByName('help thread'))!;
    expect(help).toMatchObject({ type: ChannelType.THREAD, parentChannelId: general.id, archived: false });
    expect(m6!.threadId).toBe(help.id);
    expect((await messagesIn(help.id)).map((m) => m.content)).toEqual(['in thread']);
    const old = (await channelByName('old thread'))!;
    expect(old.archived).toBe(true);
    expect((await messagesIn(old.id)).map((m) => m.content)).toEqual(['archived words']);
    const post = (await channelByName('How to tank'))!;
    expect(post.parentChannelId).toBe((await channelByName('guides'))!.id);
    expect((await messagesIn(post.id)).map((m) => m.content)).toEqual(['Tank guide body']);

    // the orphan channel: a blocked extension and an oversize file are refused, named in the text
    const orphanMessages = await messagesIn(orphan.id);
    expect(orphanMessages[0]!.content).toBe('orphan channel message\n[attachment: evil.html]\n[attachment: huge.zip]');
    expect(await tdb().select().from(messageFiles).where(eq(messageFiles.messageId, orphanMessages[0]!.id))).toHaveLength(0);
    expect(downloads.some((d) => d.url.includes('huge.zip') || d.url.includes('evil.html'))).toBe(false);
    expect(state.attachments).toEqual({ done: 1, failed: 2, skipped: 0 });
    expect(state.errors.map((e) => e.ref)).toEqual(expect.arrayContaining(['evil.html', 'huge.zip']));

    // the unreadable channel exists but carries nothing
    const secret = (await channelByName('officers-only'))!;
    expect(await messagesIn(secret.id)).toHaveLength(0);

    // every imported message has its link row
    const links = await tdb().select().from(pluginMessageLinks).where(eq(pluginMessageLinks.pluginId, IMPORT_LINK_PLUGIN_ID));
    expect(links).toHaveLength(9);
    expect(state.counts.messages!.done).toBe(9);
    expect(state.counts.messages!.skipped).toBe(1);

    // scheduled events: the upcoming one, hosted by alice; the completed one skipped
    const created = await tdb().select().from(events).where(eq(events.serverId, SERVER_ID));
    expect(created).toHaveLength(1);
    expect(created[0]!).toMatchObject({ title: 'Raid night', hostId: alice.userId, startsAt: Date.parse('2099-01-01T20:00:00Z'), endsAt: Date.parse('2099-01-01T23:00:00Z') });
    expect(created[0]!.description).toBe('Bring flasks\nWhere: Voice: Lounge');
    expect(state.counts.events).toMatchObject({ done: 1, skipped: 1 });

    // progress went to the owner only, after every page, and the final view says done
    const progress = publishSpy.mock.calls.filter(([, event]) => event === ServerEvents.IMPORT_PROGRESS);
    expect(progress.length).toBeGreaterThan(10);
    expect(progress.every(([to]) => Array.isArray(to) && to.length === 1 && to[0] === OWNER_ID)).toBe(true);
    const last = progress[progress.length - 1]![2] as { status: string; progress: { counts: Record<string, unknown> } };
    expect(last.status).toBe('done');
    expect(JSON.stringify(progress)).not.toContain(token);

    // the wizard's view
    const view = (await caller.import.getCurrent({ serverId: SERVER_ID }))!;
    expect(view.status).toBe('done');
    expect(view.progress.stepsDone).toHaveLength(10);
    expect(view.progress.finishedAt).toBe(FIXED_NOW);
  });

  test('the start route queues the run and the queue drives it to done', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);

    const started = await caller.import.start({ serverId: SERVER_ID, jobId: job.id, options: ALL });
    expect(started.status).toBe('running');
    expect(started.options).toMatchObject({ ...ALL, guildId: ids.guild });
    await expect(caller.import.start({ serverId: SERVER_ID, jobId: job.id, options: ALL })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await drainQueue(importQueue, 60_000);
    expect((await getImportJob(job.id))!.status).toBe('done');
  });
});

describe('options', () => {
  test('history none + roles skip + members nobody: structure only, nothing else', async () => {
    const { token, calls } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);

    const before = calls.length;
    expect(await runWith(job.id, { history: 'none', attachments: 'skip', members: 'nobody', roles: 'skip' })).toBe('done');
    expect(await tdb().select().from(messages).where(eq(messages.channelId, (await channelByName('general'))!.id))).toHaveLength(0);
    expect(await channelByName('help thread')).toBeUndefined();
    expect((await tdb().select().from(roles).where(eq(roles.serverId, SERVER_ID))).map((r) => r.name)).not.toContain('Raider');
    expect(await tdb().select().from(externalIdentities)).toHaveLength(0);
    const during = calls.slice(before).map((c) => c.path);
    expect(during.some((p) => p.endsWith('/messages') || p.endsWith('/pins') || p.endsWith('/members') || p.includes('/threads'))).toBe(false);
  });

  test('members nobody: every message is authored by one generic placeholder that can never be claimed', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);

    expect(await runWith(job.id, { ...ALL, members: 'nobody', attachments: 'skip' })).toBe('done');
    const general = (await channelByName('general'))!;
    const rows = await messagesIn(general.id);
    expect(rows).toHaveLength(5);
    const authors = new Set(rows.map((m) => m.userId));
    expect(authors.size).toBe(1);
    const [author] = await tdb().select().from(users).where(eq(users.id, [...authors][0]!));
    expect(author!.name).toBe('Imported history');
    expect(await identityFor(ids.alice!)).toBeUndefined();
    const [identity] = await tdb().select().from(externalIdentities);
    expect(identity!.provider).toBe('discord-import');
    // unmapped mentions degrade to names
    expect(rows[0]!.content!.startsWith('hello @bob ')).toBe(true);
  });

  test('members posters: only people who posted get placeholders; attachments skip keeps a note', async () => {
    const { token, downloads } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);

    expect(await runWith(job.id, { ...ALL, members: 'posters', attachments: 'skip' })).toBe('done');
    expect(await identityFor(ids.alice!)).toBeDefined();
    expect(await identityFor(ids.bob!)).toBeDefined();
    expect(await identityFor(ids.dave!)).toBeUndefined();
    const general = (await channelByName('general'))!;
    const [m1] = await messagesIn(general.id);
    expect(m1!.content!.endsWith('\n[attachment: map.png]')).toBe(true);
    expect(downloads.some((d) => d.url.includes('/attachments/'))).toBe(false);
    expect(readImportState((await getImportJob(job.id))!).attachments).toEqual({ done: 0, failed: 0, skipped: 3 });
  });

  test('history last30days imports only messages newer than the cutoff', async () => {
    const recentId = timestampToSnowflake(FIXED_NOW - 2 * 24 * 60 * 60 * 1000);
    const custom: TFixture = {
      ...fixture,
      messages: {
        ...fixture.messages,
        [ids.general!]: [
          ...fixture.messages[ids.general!]!,
          { id: recentId, type: 0, content: 'fresh', author: { id: ids.bob!, username: 'bob' }, timestamp: new Date(FIXED_NOW - 2 * 24 * 60 * 60 * 1000).toISOString() }
        ]
      }
    };
    const { token, calls } = useFixture({ fixture: custom });
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);

    // The preview samples pages too; only the run's requests count here.
    const previewCalls = calls.length;
    expect(await runWith(job.id, { ...ALL, history: 'last30days', attachments: 'skip' })).toBe('done');
    const general = (await channelByName('general'))!;
    expect((await messagesIn(general.id)).map((m) => m.content)).toEqual(['fresh']);
    const firstPage = calls.slice(previewCalls).find((c) => c.path === `/channels/${ids.general}/messages` && c.params.after !== undefined)!;
    expect(BigInt(firstPage.params.after!)).toBe(BigInt(timestampToSnowflake(FIXED_NOW - 30 * 24 * 60 * 60 * 1000)));
  });

  test('history last1000 probes backwards for the window start, then imports forward in order', async () => {
    const { token, calls } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);

    const before = calls.length;
    expect(await runWith(job.id, { ...ALL, history: 'last1000', attachments: 'skip' })).toBe('done');
    const general = (await channelByName('general'))!;
    expect((await messagesIn(general.id)).map((m) => m.content!.slice(0, 5))).toEqual(['hello', 'hi <@', 'Patch', 'late ', 'need ']);
    const during = calls.slice(before);
    const probe = during.filter((c) => c.path === `/channels/${ids.general}/messages` && c.params.after === undefined);
    expect(probe.length).toBeGreaterThanOrEqual(1);
    const forward = during.find((c) => c.path === `/channels/${ids.general}/messages` && c.params.after !== undefined)!;
    expect(BigInt(forward.params.after!)).toBe(BigInt(ids.m1!) - 1n);
  });
});

describe('resume, pause, cancel', () => {
  test('a failure mid-messages leaves a retryable job; retry continues from the cursor without duplicates', async () => {
    let broken = true;
    const { token } = useFixture({
      overrides: (call) =>
        broken && call.path === `/channels/${ids.orphan}/messages`
          ? { status: 500, headers: {}, body: null }
          : undefined
    });
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);

    expect(await runWith(job.id, { ...ALL, attachments: 'skip' })).toBe('failed');
    const failed = (await getImportJob(job.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.step).toBe('messages');
    expect(failed.tokenCiphertext).not.toBeNull();
    expect(failed.error).toContain('500');
    const general = (await channelByName('general'))!;
    expect(await messagesIn(general.id)).toHaveLength(5);
    const state = readImportState(failed);
    expect(state.stepsDone).not.toContain('messages');
    expect(state.cursor.messages!.index).toBeGreaterThan(0);

    broken = false;
    const retried = await caller.import.retry({ serverId: SERVER_ID, jobId: job.id });
    expect(retried.status).toBe('running');
    await drainQueue(importQueue, 60_000);

    const done = (await getImportJob(job.id))!;
    expect(done.status).toBe('done');
    expect(done.tokenCiphertext).toBeNull();
    expect(await messagesIn(general.id)).toHaveLength(5);
    expect(await tdb().select().from(pluginMessageLinks)).toHaveLength(9);
    // structure steps were not repeated
    expect((await tdb().select().from(categories).where(eq(categories.serverId, SERVER_ID)))).toHaveLength(5);
    expect(readImportState(done).counts.messages!.done).toBe(9);
  });

  test('a replayed page is a no-op: links make the insert idempotent', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    expect(await runWith(job.id, { ...ALL, attachments: 'skip' })).toBe('done');

    // Rewind the messages cursor as a crash between commit and publish would leave it.
    const row = (await getImportJob(job.id))!;
    const state = readImportState(row);
    state.stepsDone = state.stepsDone.filter((s) => s !== 'messages' && s !== 'events');
    state.cursor.messages = { ...state.cursor.messages, index: 0, after: undefined, imported: 0 };
    state.cursor.events = [];
    await tdb()
      .update(importJobs)
      .set({ progress: state, status: 'running', step: 'messages', tokenCiphertext: encryptImportToken(token) })
      .where(eq(importJobs.id, job.id));

    expect(await runImportJob(job.id)).toBe('done');
    expect(await tdb().select().from(pluginMessageLinks)).toHaveLength(9);
    const general = (await channelByName('general'))!;
    expect(await messagesIn(general.id)).toHaveLength(5);
  });

  test('pause stops after the current page, resume finishes', async () => {
    const stop: { fn?: () => Promise<unknown> } = {};
    const { token } = useFixture({
      onRequest: async (call) => {
        if (call.path === `/channels/${ids.general}/messages` && call.params.after === '0') {
          await stop.fn?.();
        }
      }
    });
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    stop.fn = () => caller.import.pause({ serverId: SERVER_ID, jobId: job.id });

    expect(await runWith(job.id, { ...ALL, attachments: 'skip' })).toBe('paused');
    const paused = (await getImportJob(job.id))!;
    expect(paused.status).toBe('paused');
    expect(paused.step).toBe('messages');
    expect(paused.tokenCiphertext).not.toBeNull();
    const general = (await channelByName('general'))!;
    // the page the pause landed on was still committed
    expect(await messagesIn(general.id)).toHaveLength(5);
    await expect(caller.import.pause({ serverId: SERVER_ID, jobId: job.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const resumed = await caller.import.resume({ serverId: SERVER_ID, jobId: job.id });
    expect(resumed.status).toBe('running');
    await drainQueue(importQueue, 60_000);
    expect((await getImportJob(job.id))!.status).toBe('done');
  });

  test('cancel from the wizard: the runner stops, the token is gone, the rows stay', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    await setImportJobOptions(job.id, { ...ALL, attachments: 'skip', guildId: ids.guild! });
    await transitionImportJob(job.id, { from: ['pending'], to: 'running', step: 'guild' });

    // Signal before the run starts: the first checkpoint sees it.
    const cancelled = await caller.import.cancel({ serverId: SERVER_ID, jobId: job.id });
    expect(cancelled.status).toBe('cancelled');
    expect(await runImportJob(job.id)).toBe('skipped');

    const row = (await getImportJob(job.id))!;
    expect(row.status).toBe('cancelled');
    expect(row.tokenCiphertext).toBeNull();
    await expect(caller.import.cancel({ serverId: SERVER_ID, jobId: job.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.import.listGuilds({ serverId: SERVER_ID, jobId: job.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // A cancelled job frees the slot for a new one.
    const next = await caller.import.createJob({ serverId: SERVER_ID, token });
    expect(next.id).toBeGreaterThan(job.id);
  });

  test('a cancel that lands mid-run stops the runner after the page', async () => {
    const stop: { fn?: () => Promise<unknown> } = {};
    const { token } = useFixture({
      onRequest: async (call) => {
        if (call.path === `/guilds/${ids.guild}/emojis`) await stop.fn?.();
      }
    });
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    stop.fn = () => caller.import.cancel({ serverId: SERVER_ID, jobId: job.id });

    expect(await runWith(job.id, ALL)).toBe('cancelled');
    const row = (await getImportJob(job.id))!;
    expect(row.status).toBe('cancelled');
    expect(row.tokenCiphertext).toBeNull();
    expect(await channelByName('general')).toBeDefined();
    expect(await identityFor(ids.alice!)).toBeUndefined();
  });
});

describe('placeholder claim', () => {
  test('signing in with the matching provider id takes the placeholder over, once, atomically', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    expect(await runWith(job.id, { ...ALL, attachments: 'skip' })).toBe('done');

    const alice = (await identityFor(ids.alice!))!;
    const placeholderId = alice.userId;
    const general = (await channelByName('general'))!;
    const before = await messagesIn(general.id);
    expect(before.filter((m) => m.userId === placeholderId)).toHaveLength(2);
    const [created] = await tdb().select().from(events);
    expect(created!.hostId).toBe(placeholderId);
    const raider = (await tdb().select().from(roles).where(eq(roles.name, 'Raider')))[0]!;

    // The real account is already a member of the server (the common case).
    const publishSpy = spyOn(pubsub, 'publishFor');
    const result = await claimExternalIdentity({ provider: 'discord', externalId: ids.alice! }, MEMBER_ID);
    expect(result).toEqual({ placeholderUserId: placeholderId, serverIds: [SERVER_ID] });

    const after = await messagesIn(general.id);
    expect(after.filter((m) => m.userId === MEMBER_ID)).toHaveLength(2);
    expect(after.filter((m) => m.userId === placeholderId)).toHaveLength(0);
    expect(await tdb().select().from(users).where(eq(users.id, placeholderId))).toHaveLength(0);
    const identity = (await identityFor(ids.alice!))!;
    expect(identity).toMatchObject({ userId: MEMBER_ID, placeholder: false });
    const memberships = await tdb().select().from(serverMembers).where(and(eq(serverMembers.serverId, SERVER_ID), eq(serverMembers.userId, MEMBER_ID)));
    expect(memberships).toHaveLength(1);
    const memberRoles = (await tdb().select().from(userRoles).where(eq(userRoles.userId, MEMBER_ID))).map((r) => r.roleId);
    expect(memberRoles).toContain(raider.id);
    // the host of the imported event followed the author (FK set null would have lost it)
    expect((await tdb().select().from(events))[0]!.hostId).toBe(MEMBER_ID);
    const deletes = publishSpy.mock.calls.filter(([, event]) => event === ServerEvents.USER_DELETE);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]![2]).toMatchObject({ serverId: SERVER_ID, userId: placeholderId });

    // Second sign-in: nothing left to claim.
    expect(await claimExternalIdentity({ provider: 'discord', externalId: ids.alice! }, MEMBER_ID)).toBeNull();
  });

  test('a real account that was not imported gets a non-placeholder identity, and a later import attributes to it directly', async () => {
    expect(await claimExternalIdentity({ provider: 'discord', externalId: ids.bob! }, MEMBER_ID)).toBeNull();
    expect((await identityFor(ids.bob!))!).toMatchObject({ userId: MEMBER_ID, placeholder: false });

    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    expect(await runWith(job.id, { ...ALL, attachments: 'skip' })).toBe('done');

    const general = (await channelByName('general'))!;
    const rows = await messagesIn(general.id);
    expect(rows[1]!.userId).toBe(MEMBER_ID); // bob's reply
    expect(rows[0]!.content).toContain(`<@${MEMBER_ID}>`);
    expect(await tdb().select().from(users).where(eq(users.supabaseId, `placeholder:discord:${ids.bob}`))).toHaveLength(0);
  });

  test('claiming into a server the account was not in moves the membership instead of dropping it', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    expect(await runWith(job.id, { ...ALL, attachments: 'skip' })).toBe('done');

    const dave = (await identityFor(ids.dave!))!;
    const [outsider] = await tdb().insert(users).values({ name: 'Dave Real', supabaseId: 'real-dave', publicId: 'real-dave-pid', createdAt: Date.now() }).returning();
    await claimExternalIdentity({ provider: 'discord', externalId: ids.dave! }, outsider!.id);
    expect(await tdb().select().from(serverMembers).where(and(eq(serverMembers.serverId, SERVER_ID), eq(serverMembers.userId, outsider!.id)))).toHaveLength(1);
    expect(await tdb().select().from(serverMembers).where(eq(serverMembers.userId, dave.userId))).toHaveLength(0);
  });

  test('providerIdentityFromAuth recognises the provider by issuer host only', () => {
    expect(providerIdentityFromAuth({ metadata: { iss: 'https://discord.com/api', provider_id: '700000000000000001' } })).toEqual({ provider: 'discord', externalId: '700000000000000001' });
    expect(providerIdentityFromAuth({ metadata: { iss: 'https://discord.com', sub: '700000000000000001' } })).toEqual({ provider: 'discord', externalId: '700000000000000001' });
    expect(providerIdentityFromAuth({ metadata: { iss: 'https://accounts.google.com', provider_id: '700000000000000001' } })).toBeNull();
    expect(providerIdentityFromAuth({ metadata: { iss: 'https://discord.com.evil.example', provider_id: '700000000000000001' } })).toBeNull();
    expect(providerIdentityFromAuth({ metadata: { iss: 'https://discord.com', provider_id: 'abc' } })).toBeNull();
    expect(providerIdentityFromAuth({ metadata: { provider_id: '700000000000000001' } })).toBeNull();
    expect(providerIdentityFromAuth({})).toBeNull();
  });

  test('placeholders cannot open a session', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    expect(await runWith(job.id, { ...ALL, history: 'none', attachments: 'skip' })).toBe('done');
    const alice = (await identityFor(ids.alice!))!;
    // The auth-side id is the test token; a placeholder's id is never issued by an auth backend,
    // and the auth mock's getUser hands back exactly the token — so this is the strongest check
    // available here: the shape itself.
    const [user] = await tdb().select().from(users).where(eq(users.id, alice.userId));
    expect(user!.supabaseId.startsWith('placeholder:')).toBe(true);
    expect(/^[0-9a-f-]{36}$/.test(user!.supabaseId)).toBe(false);
  });
});

describe('importing the same guild again', () => {
  test('matches the layout the earlier job created instead of creating it again', async () => {
    const { token } = useFixture();
    const { caller } = await initTest(OWNER_ID);
    const { job } = await connectAndPreview(caller, token);
    expect(await runWith(job.id, { ...ALL, attachments: 'skip', members: 'nobody' })).toBe('done');

    const count = async () => ({
      categories: (await tdb().select().from(categories).where(eq(categories.serverId, SERVER_ID))).length,
      channels: (await tdb().select().from(channels).where(eq(channels.serverId, SERVER_ID))).length,
      roles: (await tdb().select().from(roles).where(eq(roles.serverId, SERVER_ID))).length,
      emojis: (await tdb().select().from(emojis).where(eq(emojis.serverId, SERVER_ID))).length
    });
    const before = await count();
    const first = readImportState((await getImportJob(job.id))!).map;
    expect(Object.keys(first.channels).length).toBeGreaterThan(0);

    // One channel was deleted in between: that one alone comes back.
    const deleted = (await channelByName('general'))!;
    await tdb().delete(channels).where(eq(channels.id, deleted.id));

    // The owner runs the import again (wider bot access, newer history):
    // every other row is matched and nothing doubles.
    const { job: again } = await connectAndPreview(caller, token);
    expect(await runWith(again.id, { ...ALL, attachments: 'skip', members: 'nobody' })).toBe('done');

    expect(await count()).toEqual(before);
    const state = readImportState((await getImportJob(again.id))!);
    expect(state.map.categories).toEqual(first.categories);
    expect(state.map.roles).toEqual(first.roles);
    expect(state.map.emojis).toEqual(first.emojis);
    const general = (await channelByName('general'))!;
    expect(general.id).not.toBe(deleted.id);
    expect(state.map.channels).toEqual({ ...first.channels, [ids.general!]: general.id });
    expect(Object.keys(state.map.threads).sort()).toEqual(Object.keys(first.threads).sort());
    expect(state.warnings.some((w) => w.startsWith('Matched ') && w.includes('were not created again'))).toBe(true);
    expect(await messagesIn(general.id)).toHaveLength(5);
  });
});
