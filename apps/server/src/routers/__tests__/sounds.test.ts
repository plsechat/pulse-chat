import {
  ActivityLogType,
  Permission,
  SOUND_MAX_FILE_BYTES,
  SOUNDS_PER_SERVER_MAX,
  type TTempFile
} from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  createTestRole,
  grantTestUserRole,
  insertMemberUser,
  insertOtherServer,
  insertVoiceChannel,
  stageUserInVoice
} from '../../__tests__/fixtures';
import { firstSubscriptionEvent, initTest, uploadFile } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { getOrphanedFileIds, isFileOrphaned } from '../../db/queries/files';
import { getDefaultRoleForServer } from '../../db/queries/roles';
import { activityLog, files, serverSounds, servers } from '../../db/schema';
import { activityLogQueue } from '../../queues/activity-log';
import { drainQueue } from '../../queues/drain';
import { VoiceRuntime } from '../../runtimes/voice';
import { soundboardLimiter } from '../../utils/soundboard-limits';
import type { TSoundPlayEvent } from '../../types';

type Caller = Awaited<ReturnType<typeof initTest>>['caller'];

/**
 * A valid RIFF/WAVE header followed by `pcmBytes` of silence — enough
 * for the type sniff (by extension) and the size bound; the server
 * never decodes it.
 */
const wavBytes = (pcmBytes = 800): Uint8Array => {
  const buf = new ArrayBuffer(44 + pcmBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcmBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, pcmBytes, true);
  return new Uint8Array(buf);
};

const stageUpload = async (
  mockedToken: string,
  name = 'clip.wav',
  bytes: Uint8Array = wavBytes(),
  type = 'audio/wav'
) => {
  const file = new File([bytes], name, { type });
  const response = await uploadFile(file, mockedToken);
  expect(response.status).toBe(200);
  return (await response.json()) as TTempFile;
};

const addSound = async (
  caller: Caller,
  mockedToken: string,
  input: { name: string; emoji?: string; volume?: number; serverId?: number } = {
    name: 'airhorn'
  }
) => {
  const temp = await stageUpload(mockedToken);
  return caller.sounds.add({
    serverId: input.serverId ?? 1,
    tempFileId: temp.id,
    name: input.name,
    emoji: input.emoji,
    volume: input.volume
  });
};

/**
 * A fresh member with the seeded default Member role (the join path
 * grants it; the raw fixture does not), i.e. JOIN_VOICE_CHANNELS and
 * USE_SOUNDBOARD among the defaults.
 */
const insertDefaultRoleMember = async () => {
  const member = await insertMemberUser();
  const defaultRole = await getDefaultRoleForServer(1);
  await grantTestUserRole(member.id, defaultRole!.id);
  return member;
};

describe('sounds — management routes', () => {
  test('MANAGE_SOUNDS uploads a clip; members list it with its file', async () => {
    const { caller, mockedToken } = await initTest(1);

    const { id } = await addSound(caller, mockedToken, {
      name: 'Airhorn',
      emoji: '📯',
      volume: 80
    });

    const member = await insertMemberUser();
    const { caller: memberCaller } = await initTest(member.id);
    const sounds = await memberCaller.sounds.getAll();

    expect(sounds).toHaveLength(1);
    expect(sounds[0]).toMatchObject({
      id,
      serverId: 1,
      name: 'Airhorn',
      emoji: '📯',
      volume: 80,
      createdBy: 1
    });
    expect(sounds[0]!.file.name).toMatch(/\.wav$/);
    expect(typeof sounds[0]!.file.id).toBe('number');

    // The upload is audited under the uploader.
    await drainQueue(activityLogQueue);
    const [entry] = await getTestDb()
      .select()
      .from(activityLog)
      .where(eq(activityLog.type, ActivityLogType.CREATED_SOUND));
    expect(entry).toMatchObject({ userId: 1, details: { name: 'Airhorn' } });
  });

  test('a plain member cannot add, rename or delete sounds', async () => {
    const member = await insertMemberUser();
    const { caller, mockedToken } = await initTest(member.id);
    const temp = await stageUpload(mockedToken);

    await expect(
      caller.sounds.add({ serverId: 1, tempFileId: temp.id, name: 'nope' })
    ).rejects.toThrow('Insufficient permissions');
    await expect(
      caller.sounds.update({ soundId: 1, name: 'nope' })
    ).rejects.toThrow('Insufficient permissions');
    await expect(caller.sounds.delete({ soundId: 1 })).rejects.toThrow(
      'Insufficient permissions'
    );
  });

  test('a MANAGE_SOUNDS role (not owner) can manage; input bounds hold', async () => {
    const manager = await insertMemberUser();
    const roleId = await createTestRole({
      serverId: 1,
      name: 'Sound crew',
      permissions: [Permission.MANAGE_SOUNDS]
    });
    await grantTestUserRole(manager.id, roleId);
    const { caller, mockedToken } = await initTest(manager.id);

    const { id } = await addSound(caller, mockedToken, { name: 'Drum' });
    await caller.sounds.update({ soundId: id, name: 'Drum roll', volume: 55, emoji: null });

    const [row] = await caller.sounds.getAll();
    expect(row).toMatchObject({ name: 'Drum roll', volume: 55, emoji: null });

    // Bounds: name length, volume range, emoji length, empty patch.
    const temp = await stageUpload(mockedToken);
    await expect(
      caller.sounds.add({ serverId: 1, tempFileId: temp.id, name: 'x'.repeat(41) })
    ).rejects.toThrow();
    await expect(
      caller.sounds.update({ soundId: id, volume: 101 })
    ).rejects.toThrow();
    await expect(
      caller.sounds.update({ soundId: id, emoji: 'e'.repeat(17) })
    ).rejects.toThrow();
    await expect(caller.sounds.update({ soundId: id })).rejects.toThrow(
      'Nothing to change'
    );
  });

  test('names are unique per server, case-insensitively', async () => {
    const { caller, mockedToken } = await initTest(1);
    await addSound(caller, mockedToken, { name: 'Boom' });

    await expect(addSound(caller, mockedToken, { name: 'boom' })).rejects.toThrow(
      'already exists'
    );

    const { id } = await addSound(caller, mockedToken, { name: 'Crash' });
    await expect(
      caller.sounds.update({ soundId: id, name: 'BOOM' })
    ).rejects.toThrow('already exists');
    // Renaming to its own name (different case) is fine.
    await caller.sounds.update({ soundId: id, name: 'crash' });
  });

  test('refuses files that are not small audio', async () => {
    const { caller, mockedToken } = await initTest(1);

    const png = await stageUpload(mockedToken, 'pic.png', new Uint8Array(64), 'image/png');
    await expect(
      caller.sounds.add({ serverId: 1, tempFileId: png.id, name: 'pic' })
    ).rejects.toThrow('Not an audio file');

    const big = await stageUpload(
      mockedToken,
      'long.wav',
      wavBytes(SOUND_MAX_FILE_BYTES),
      'audio/wav'
    );
    await expect(
      caller.sounds.add({ serverId: 1, tempFileId: big.id, name: 'long' })
    ).rejects.toThrow('at most');

    // A refused upload is released: the token is gone.
    await expect(
      caller.sounds.add({ serverId: 1, tempFileId: png.id, name: 'again' })
    ).rejects.toThrow('Uploaded file not found');

    // A token belonging to someone else is not usable either.
    const other = await insertMemberUser();
    const { mockedToken: otherToken } = await initTest(other.id);
    const theirs = await stageUpload(otherToken);
    await expect(
      caller.sounds.add({ serverId: 1, tempFileId: theirs.id, name: 'theirs' })
    ).rejects.toThrow('Uploaded file not found');

    expect(await caller.sounds.getAll()).toHaveLength(0);
  });

  test('a server holds at most SOUNDS_PER_SERVER_MAX clips', async () => {
    const { caller, mockedToken } = await initTest(1);
    const tdb = getTestDb();

    // Fill the shelf directly (one real upload would do; 50 would be slow).
    const [file] = await tdb
      .insert(files)
      .values({
        name: `filler-${Date.now()}.wav`,
        originalName: 'filler.wav',
        md5: 'md5-filler',
        userId: 1,
        size: 100,
        mimeType: 'audio/wav',
        extension: '.wav',
        createdAt: Date.now()
      })
      .returning();
    await tdb.insert(serverSounds).values(
      Array.from({ length: SOUNDS_PER_SERVER_MAX }, (_, i) => ({
        serverId: 1,
        name: `filler ${i}`,
        fileId: file!.id,
        volume: 100,
        createdBy: 1,
        createdAt: Date.now()
      }))
    );

    await expect(addSound(caller, mockedToken, { name: 'one more' })).rejects.toThrow(
      `at most ${SOUNDS_PER_SERVER_MAX}`
    );
  });

  test('cross-server scope: another server\'s sound is not found from here', async () => {
    const { caller, mockedToken } = await initTest(1);
    const other = await insertOtherServer();
    await getTestDb().update(servers).set({ ownerId: 1 }).where(eq(servers.id, other.id));

    // Owner of both servers; adds to the OTHER one by serverId …
    const { id } = await addSound(caller, mockedToken, { name: 'Elsewhere', serverId: other.id });

    // … but the active server is 1, so by-id routes do not see it.
    await expect(caller.sounds.update({ soundId: id, name: 'x' })).rejects.toThrow(
      'Sound not found'
    );
    await expect(caller.sounds.delete({ soundId: id })).rejects.toThrow('Sound not found');
    expect(await caller.sounds.getAll()).toHaveLength(0);
  });

  test('the file is protected from the orphan sweep while the sound exists and removed with it', async () => {
    const { caller, mockedToken } = await initTest(1);
    const { id } = await addSound(caller, mockedToken, { name: 'Keep me' });

    const [row] = await getTestDb()
      .select({ fileId: serverSounds.fileId })
      .from(serverSounds)
      .where(eq(serverSounds.id, id));
    const fileId = row!.fileId;

    expect(await isFileOrphaned(fileId)).toBe(false);
    expect(await getOrphanedFileIds()).not.toContain(fileId);

    await caller.sounds.delete({ soundId: id });

    const [fileRow] = await getTestDb()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.id, fileId)));
    expect(fileRow).toBeUndefined();
    expect(await caller.sounds.getAll()).toHaveLength(0);

    await drainQueue(activityLogQueue);
    const types = (await getTestDb().select({ type: activityLog.type }).from(activityLog)).map(
      (r) => r.type
    );
    expect(types).toContain(ActivityLogType.DELETED_SOUND);
  });

  test('list/create/update/delete fan out to server members', async () => {
    const { caller, mockedToken } = await initTest(1);
    const member = await insertMemberUser();
    const { caller: memberCaller } = await initTest(member.id);

    const created = await firstSubscriptionEvent<{ id: number; name: string }>(
      memberCaller,
      'sounds',
      'onCreate',
      () => addSound(caller, mockedToken, { name: 'Ping' })
    );
    expect(created.name).toBe('Ping');

    const updated = await firstSubscriptionEvent<{ id: number; name: string }>(
      memberCaller,
      'sounds',
      'onUpdate',
      () => caller.sounds.update({ soundId: created.id, name: 'Pong' })
    );
    expect(updated).toMatchObject({ id: created.id, name: 'Pong' });

    const deleted = await firstSubscriptionEvent<{ soundId: number; serverId: number }>(
      memberCaller,
      'sounds',
      'onDelete',
      () => caller.sounds.delete({ soundId: created.id })
    );
    expect(deleted).toEqual({ soundId: created.id, serverId: 1 });
  });
});

describe('voice.playSound', () => {
  test('a member in the room triggers a clip and the room receives the fan-out', async () => {
    soundboardLimiter.reset();
    const { caller: owner, mockedToken } = await initTest(1);
    const { id } = await addSound(owner, mockedToken, { name: 'Tada', emoji: '🎉', volume: 70 });

    const member = await insertDefaultRoleMember();
    const listener = await insertDefaultRoleMember();
    const channel = await insertVoiceChannel();
    const runtime = stageUserInVoice(channel.id, member.id);
    runtime.addUser(listener.id, { micMuted: false, soundMuted: false });

    try {
      const { caller, ctx } = await initTest(member.id);
      ctx.currentVoiceChannelId = channel.id;
      const { caller: listenerCaller, ctx: listenerCtx } = await initTest(listener.id);
      listenerCtx.currentVoiceChannelId = channel.id;

      const listing = await caller.voice.listSounds();
      expect(listing.serverId).toBe(1);
      expect(listing.canPlay).toBe(true);
      expect(listing.sounds.map((s) => s.name)).toEqual(['Tada']);

      const event = await firstSubscriptionEvent<TSoundPlayEvent>(
        listenerCaller,
        'voice',
        'onSoundPlay',
        () => caller.voice.playSound({ channelId: channel.id, soundId: id })
      );

      expect(event).toMatchObject({
        channelId: channel.id,
        soundId: id,
        userId: member.id,
        name: 'Tada',
        emoji: '🎉',
        volume: 70
      });
      expect(event.file.name).toMatch(/\.wav$/);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('refused when not in that room, in a DM call, or for another server\'s sound', async () => {
    soundboardLimiter.reset();
    const { caller: owner, mockedToken } = await initTest(1);
    const { id } = await addSound(owner, mockedToken, { name: 'Tada' });

    const member = await insertDefaultRoleMember();
    const channel = await insertVoiceChannel();
    const otherChannel = await insertVoiceChannel();
    stageUserInVoice(channel.id, member.id);

    try {
      const { caller, ctx } = await initTest(member.id);

      // Connection never joined.
      await expect(
        caller.voice.playSound({ channelId: channel.id, soundId: id })
      ).rejects.toThrow('User is not in that voice channel');
      await expect(caller.voice.listSounds()).rejects.toThrow('User is not in a voice channel');

      // Joined, but names a different room.
      ctx.currentVoiceChannelId = channel.id;
      await expect(
        caller.voice.playSound({ channelId: otherChannel.id, soundId: id })
      ).rejects.toThrow('User is not in that voice channel');

      // A DM-call session has no soundboard.
      ctx.currentDmVoiceChannelId = channel.id;
      await expect(
        caller.voice.playSound({ channelId: channel.id, soundId: id })
      ).rejects.toThrow('User is not in that voice channel');
      ctx.currentDmVoiceChannelId = undefined;

      // A sound of another server, by id.
      const other = await insertOtherServer();
      await getTestDb().update(servers).set({ ownerId: 1 }).where(eq(servers.id, other.id));
      const foreign = await addSound(owner, mockedToken, { name: 'Foreign', serverId: other.id });
      await expect(
        caller.voice.playSound({ channelId: channel.id, soundId: foreign.id })
      ).rejects.toThrow('Sound not found');
      await expect(
        caller.voice.playSound({ channelId: channel.id, soundId: 999_999 })
      ).rejects.toThrow('Sound not found');
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
      await VoiceRuntime.findById(otherChannel.id)?.destroy();
    }
  });

  test('refuses a server-muted member', async () => {
    soundboardLimiter.reset();
    const { caller: owner, mockedToken } = await initTest(1);
    const { id } = await addSound(owner, mockedToken, { name: 'Tada' });

    const member = await insertDefaultRoleMember();
    const channel = await insertVoiceChannel();
    const runtime = stageUserInVoice(channel.id, member.id);

    try {
      const { caller, ctx } = await initTest(member.id);
      ctx.currentVoiceChannelId = channel.id;

      runtime.setModerationOverride(member.id, { serverMuted: true });
      await expect(
        caller.voice.playSound({ channelId: channel.id, soundId: id })
      ).rejects.toThrow('muted by a moderator');

      // Lifting the mute lifts the refusal.
      runtime.setModerationOverride(member.id, { serverMuted: false });
      await caller.voice.playSound({ channelId: channel.id, soundId: id });
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('requires USE_SOUNDBOARD (a voice-only role cannot trigger; listSounds says so)', async () => {
    soundboardLimiter.reset();
    const { caller: owner, mockedToken } = await initTest(1);
    const { id } = await addSound(owner, mockedToken, { name: 'Tada' });

    const member = await insertMemberUser();
    const roleId = await createTestRole({
      serverId: 1,
      name: 'Voice only',
      permissions: [Permission.JOIN_VOICE_CHANNELS]
    });
    await grantTestUserRole(member.id, roleId);
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, member.id);

    try {
      const { caller, ctx } = await initTest(member.id);
      ctx.currentVoiceChannelId = channel.id;

      await expect(
        caller.voice.playSound({ channelId: channel.id, soundId: id })
      ).rejects.toThrow('Insufficient permissions');

      const listing = await caller.voice.listSounds();
      expect(listing.canPlay).toBe(false);
      expect(listing.sounds).toHaveLength(1);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('a second trigger inside the cooldown is refused', async () => {
    soundboardLimiter.reset();
    const { caller: owner, mockedToken } = await initTest(1);
    const { id } = await addSound(owner, mockedToken, { name: 'Tada' });

    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, 1);

    try {
      const { caller, ctx } = await initTest(1);
      ctx.currentVoiceChannelId = channel.id;

      await caller.voice.playSound({ channelId: channel.id, soundId: id });
      await expect(
        caller.voice.playSound({ channelId: channel.id, soundId: id })
      ).rejects.toThrow('Wait a moment');
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });
});
