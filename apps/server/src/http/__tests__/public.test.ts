import { ChannelType, type TFile, type TTempFile } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import { initTest, login, uploadFile } from '../../__tests__/helpers';
import { tdb, testsBaseUrl } from '../../__tests__/setup';
import { loadCrons } from '../../crons';
import { ORPHAN_GRACE_MS } from '../../crons/cleanup-files';
import { removeFile } from '../../db/mutations/files';
import * as filesQueries from '../../db/queries/files';
import { getOrphanedFileIds, isFileOrphaned } from '../../db/queries/files';
import {
  channels,
  dmChannels,
  dmMessageFiles,
  dmMessages,
  files,
  messageFiles,
  messages,
  webhooks
} from '../../db/schema';
import {
  dmFileSalt,
  FILE_TOKEN_MAX_TTL_MS,
  generateFileToken
} from '../../helpers/files-crypto';
import { PUBLIC_PATH } from '../../helpers/paths';
import { fileExists, fileManager } from '../../utils/file-manager';

const PUBLIC_CSP = "default-src 'none'; sandbox";
const CACHE_PUBLIC = 'public, max-age=31536000, immutable';
const CACHE_PRIVATE = 'private, max-age=43200';

// The memo test spies on a query export; restore so later tests (and
// files) see the real function.
afterEach(() => {
  mock.restore();
});

/**
 * Seed a stored file directly (disk + files row + message_files link in
 * channel 1) with an arbitrary name/MIME. The /upload denylist now
 * refuses scriptable extensions, but files stored BEFORE the denylist
 * grew are exactly the threat /public must neutralise, so the serve
 * tests bypass intake.
 */
const seedStoredFile = async ({
  name,
  originalName,
  mimeType,
  content
}: {
  name: string;
  originalName: string;
  mimeType: string;
  content: string;
}) => {
  const now = Date.now();

  await fs.writeFile(path.join(PUBLIC_PATH, name), content);

  const [dbFile] = await tdb
    .insert(files)
    .values({
      name,
      originalName,
      md5: `md5-${name}`,
      userId: 1,
      size: Buffer.byteLength(content),
      mimeType,
      extension: path.extname(name),
      createdAt: now
    })
    .returning();

  const [message] = await tdb
    .insert(messages)
    .values({ userId: 1, channelId: 1, content: 'seeded', createdAt: now })
    .returning();

  await tdb.insert(messageFiles).values({
    messageId: message!.id,
    fileId: dbFile!.id,
    createdAt: now
  });

  return dbFile!;
};

const upload = async (file: File, token: string) => {
  const uploadResponse = await uploadFile(file, token);
  const uploadData = (await uploadResponse.json()) as TTempFile;

  return uploadData;
};

const getFileByMessageId = async (
  messageId: number
): Promise<TFile | undefined> => {
  const [messageFile] = await tdb
    .select()
    .from(messageFiles)
    .where(eq(messageFiles.messageId, messageId))
    .limit(1);

  if (!messageFile) {
    return undefined;
  }

  const [dbFile] = await tdb
    .select()
    .from(files)
    .where(eq(files.id, messageFile.fileId))
    .limit(1);

  return dbFile;
};

type TSeededFile = {
  name: string;
  content: string;
  messageId: number | null;
  tempFile: TTempFile | null;
};

/**
 * Upload three files as the owner: the first two attached to messages
 * in channel 1 (non-orphaned), the third saved manually as an orphan.
 * Called inside each test (not beforeEach) so these writes don't pile
 * onto the global per-test TRUNCATE inside the same hook budget.
 */
const setup = async (): Promise<{
  token: string;
  filesToCreate: TSeededFile[];
}> => {
  const response = await login('testowner', 'password123');
  const data = (await response.json()) as { accessToken: string };
  const token = data.accessToken;

  const filesToCreate: TSeededFile[] = [
    {
      name: 'test-public.txt',
      content: 'This is a test file for public endpoint.',
      messageId: null,
      tempFile: null
    },
    {
      name: 'another-test.txt',
      content: 'This is another test file.',
      messageId: null,
      tempFile: null
    },
    {
      name: 'orphan.txt',
      content: 'This is an orphaned file.',
      messageId: null,
      tempFile: null
    }
  ];

  for (const fileData of filesToCreate) {
    fileData.tempFile = await upload(
      new File([fileData.content], fileData.name, { type: 'text/plain' }),
      token
    );
  }

  // add first two files to messages to make them non-orphaned
  for (let i = 0; i < 2; i++) {
    const { caller } = await initTest();

    filesToCreate[i]!.messageId = await caller.messages.send({
      content: 'Message with file',
      channelId: 1,
      files: [filesToCreate[i]!.tempFile!.id]
    });
  }

  // third we save manually as orphan
  await fileManager.saveFile(filesToCreate[2]!.tempFile!.id, 1);

  return { token, filesToCreate };
};

describe('/public', () => {
  test('files were created in public folder', async () => {
    const { filesToCreate } = await setup();
    for (const fileData of filesToCreate) {
      if (!fileData.messageId) continue;

      const dbFile = await getFileByMessageId(fileData.messageId);

      expect(dbFile).toBeDefined();

      const filePath = path.join(PUBLIC_PATH, dbFile!.name);

      expect(await fileExists(filePath)).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toBe(fileData.content);
    }
  });

  test('should serve a file successfully', async () => {
    const { filesToCreate } = await setup();
    const file = filesToCreate[0];

    expect(file).toBeDefined();
    expect(file!.messageId).toBeDefined();

    const dbFile = await getFileByMessageId(file!.messageId!);

    expect(dbFile).toBeDefined();
    expect(dbFile?.name).toBeDefined();

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}`
    );

    expect(response.status).toBe(200);
    // text/* is not on the inline allowlist: served as a download with a
    // neutral type so the stored Content-Type can never render.
    expect(response.headers.get('Content-Type')).toBe(
      'application/octet-stream'
    );
    expect(response.headers.get('Content-Length')).toBe(
      dbFile!.size.toString()
    );
    // Content-Disposition carries the real (original) filename for
    // download, not the random stored name.
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="${dbFile!.originalName}"`
    );
    expect(response.headers.get('Content-Security-Policy')).toBe(PUBLIC_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const responseText = await response.text();

    expect(responseText).toBe(file!.content);
  });

  test('stored .shtml and .ts files are served as octet-stream attachments under a sandboxing CSP', async () => {
    const now = Date.now();
    const seeded = [
      await seedStoredFile({
        name: `page-${now}.shtml`,
        originalName: 'page.shtml',
        mimeType: 'text/html;charset=utf-8',
        content: '<script src="/public/x.ts"></script>'
      }),
      await seedStoredFile({
        name: `script-${now}.ts`,
        originalName: 'script.ts',
        mimeType: 'text/javascript;charset=utf-8',
        content:
          'fetch("/steal?" + localStorage.getItem("pulse:auth:access_token"))'
      }),
      await seedStoredFile({
        name: `vector-${now}.svg`,
        originalName: 'vector.svg',
        mimeType: 'image/svg+xml',
        content: '<svg onload="alert(1)"/>'
      })
    ];

    try {
      for (const dbFile of seeded) {
        const response = await fetch(
          `${testsBaseUrl}/public/${encodeURIComponent(dbFile.name)}`
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe(
          'application/octet-stream'
        );
        expect(response.headers.get('Content-Disposition')).toBe(
          `attachment; filename="${dbFile.originalName}"`
        );
        expect(response.headers.get('Content-Security-Policy')).toBe(
          PUBLIC_CSP
        );
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      }
    } finally {
      for (const dbFile of seeded) {
        await fs.rm(path.join(PUBLIC_PATH, dbFile.name), { force: true });
      }
    }
  });

  test('images, video, audio and pdf stay inline with their real type, still under the CSP', async () => {
    const now = Date.now();
    const seeded = [
      await seedStoredFile({
        name: `pic-${now}.png`,
        originalName: 'pic.png',
        mimeType: 'image/png',
        content: 'png-bytes'
      }),
      await seedStoredFile({
        name: `clip-${now}.mp4`,
        originalName: 'clip.mp4',
        mimeType: 'video/mp4',
        content: 'mp4-bytes'
      }),
      await seedStoredFile({
        name: `song-${now}.mp3`,
        originalName: 'song.mp3',
        mimeType: 'audio/mpeg',
        content: 'mp3-bytes'
      }),
      await seedStoredFile({
        name: `doc-${now}.pdf`,
        originalName: 'doc.pdf',
        mimeType: 'application/pdf',
        content: 'pdf-bytes'
      })
    ];

    try {
      for (const dbFile of seeded) {
        const response = await fetch(
          `${testsBaseUrl}/public/${encodeURIComponent(dbFile.name)}`
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe(dbFile.mimeType);
        expect(response.headers.get('Content-Disposition')).toBe(
          `inline; filename="${dbFile.originalName}"`
        );
        expect(response.headers.get('Content-Security-Policy')).toBe(
          PUBLIC_CSP
        );
      }
    } finally {
      for (const dbFile of seeded) {
        await fs.rm(path.join(PUBLIC_PATH, dbFile.name), { force: true });
      }
    }
  });

  test('a non-ASCII original name gets an RFC 5987 filename* instead of a 500', async () => {
    const dbFile = await seedStoredFile({
      name: `unicode-${Date.now()}.png`,
      originalName: 'Ünïcödé 画像.png',
      mimeType: 'image/png',
      content: 'png-bytes'
    });

    try {
      const response = await fetch(
        `${testsBaseUrl}/public/${encodeURIComponent(dbFile.name)}`
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toBe(
        `inline; filename="_n_c_d_ __.png"; filename*=UTF-8''${encodeURIComponent(dbFile.originalName)}`
      );
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, dbFile.name), { force: true });
    }
  });

  test('malformed percent-encoding in the path is a 400, not a 500', async () => {
    const response = await fetch(`${testsBaseUrl}/public/%E0`);

    expect(response.status).toBe(400);

    const data = (await response.json()) as { error: string };

    expect(data).toHaveProperty('error', 'Bad request');
    // Error responses carry the CSP too.
    expect(response.headers.get('Content-Security-Policy')).toBe(PUBLIC_CSP);
  });

  test('a file referenced only by a webhook avatar is not orphaned and is served', async () => {
    const now = Date.now();
    const name = `webhook-avatar-${now}.png`;

    await fs.writeFile(path.join(PUBLIC_PATH, name), 'png-bytes');

    const [dbFile] = await tdb
      .insert(files)
      .values({
        name,
        originalName: 'avatar.png',
        md5: `md5-${name}`,
        userId: 1,
        size: 9,
        mimeType: 'image/png',
        extension: '.png',
        createdAt: now
      })
      .returning();

    try {
      // Unreferenced: orphaned (and 404 on /public).
      expect(await isFileOrphaned(dbFile!.id)).toBe(true);

      await tdb.insert(webhooks).values({
        name: 'Avatar hook',
        channelId: 1,
        token: `hook-${now}`,
        avatarFileId: dbFile!.id,
        createdBy: 1,
        serverId: 1,
        createdAt: now
      });

      expect(await isFileOrphaned(dbFile!.id)).toBe(false);
      expect(await getOrphanedFileIds()).not.toContain(dbFile!.id);

      const response = await fetch(
        `${testsBaseUrl}/public/${encodeURIComponent(name)}`
      );

      expect(response.status).toBe(200);
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, name), { force: true });
    }
  });

  test('a file referenced only by a group-DM icon is not orphaned and is served', async () => {
    const now = Date.now();
    const name = `dm-icon-${now}.png`;

    await fs.writeFile(path.join(PUBLIC_PATH, name), 'png-bytes');

    const [dbFile] = await tdb
      .insert(files)
      .values({
        name,
        originalName: 'icon.png',
        md5: `md5-${name}`,
        userId: 1,
        size: 9,
        mimeType: 'image/png',
        extension: '.png',
        createdAt: now
      })
      .returning();

    try {
      expect(await isFileOrphaned(dbFile!.id)).toBe(true);

      await tdb.insert(dmChannels).values({
        name: 'Group with icon',
        ownerId: 1,
        iconFileId: dbFile!.id,
        isGroup: true,
        createdAt: now
      });

      expect(await isFileOrphaned(dbFile!.id)).toBe(false);
      expect(await getOrphanedFileIds()).not.toContain(dbFile!.id);

      const response = await fetch(
        `${testsBaseUrl}/public/${encodeURIComponent(name)}`
      );

      expect(response.status).toBe(200);
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, name), { force: true });
    }
  });

  test('should return 404 when file not found in database', async () => {
    const response = await fetch(`${testsBaseUrl}/public/nonexistent-file.txt`);

    expect(response.status).toBe(404);

    const data = (await response.json()) as { error: string };

    expect(data).toHaveProperty('error', 'File not found');
  });

  test('should return 404 when file is orphaned', async () => {
    const { filesToCreate } = await setup();
    const orphanFile = filesToCreate[2];

    expect(orphanFile).toBeDefined();
    expect(orphanFile!.tempFile).toBeDefined();
    expect(orphanFile!.messageId).toBeNull();

    const [dbFile] = await tdb
      .select()
      .from(files)
      .where(eq(files.md5, orphanFile!.tempFile!.md5))
      .limit(1);

    expect(dbFile).toBeDefined();

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}`
    );

    expect(response.status).toBe(404);

    const data = (await response.json()) as { error: string };

    expect(data).toHaveProperty('error', 'File not found');
  });

  test('should return 404 when file exists in database but not on disk', async () => {
    const missingFileName = `test-missing-${Date.now()}.txt`;

    const [message] = await tdb
      .insert(messages)
      .values({
        userId: 1,
        channelId: 1,
        content: 'Message with missing file',
        createdAt: Date.now()
      })
      .returning();

    const [missingFile] = await tdb
      .insert(files)
      .values({
        name: missingFileName,
        originalName: 'missing.txt',
        md5: 'missing-md5',
        userId: 1,
        size: 100,
        mimeType: 'text/plain',
        extension: '.txt',
        createdAt: Date.now()
      })
      .returning();

    await tdb.insert(messageFiles).values({
      messageId: message!.id,
      fileId: missingFile!.id,
      createdAt: Date.now()
    });

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(missingFileName)}`
    );

    expect(response.status).toBe(404);

    const data = (await response.json()) as { error: string };

    expect(data).toHaveProperty('error', 'File not found on disk');
  });

  test('should return 404 when URL is invalid', async () => {
    const response = await fetch(`${testsBaseUrl}/public/`);

    expect(response.status).toBe(404);
  });

  test('should delete file when message is deleted', async () => {
    const { filesToCreate } = await setup();
    const orphanFile = filesToCreate[0];

    const dbFile = await getFileByMessageId(orphanFile!.messageId!);

    expect(dbFile).toBeDefined();

    // file exists and it's linked to a message
    expect(await fileExists(path.join(PUBLIC_PATH, dbFile!.name))).toBe(true);

    const { caller } = await initTest();

    await caller.messages.delete({
      messageId: orphanFile!.messageId!
    });

    const [afterDbFile] = await tdb
      .select()
      .from(files)
      .where(eq(files.id, dbFile!.id))
      .limit(1);

    // file record is deleted
    expect(afterDbFile).toBeUndefined();

    // file is deleted from disk
    expect(await fileExists(path.join(PUBLIC_PATH, dbFile!.name))).toBe(false);
  });

  test('should delete file inside message when channel is deleted', async () => {
    const { filesToCreate } = await setup();
    const orphanFile = filesToCreate[1];

    const dbFile = await getFileByMessageId(orphanFile!.messageId!);

    expect(dbFile).toBeDefined();

    // file exists and it's linked to a message
    expect(await fileExists(path.join(PUBLIC_PATH, dbFile!.name))).toBe(true);

    const { caller } = await initTest();

    await caller.channels.delete({
      channelId: 1
    });

    // The cleanup sweep leaves rows younger than its grace window alone
    // (a just-uploaded file may not be linked yet — see
    // crons/cleanup-files.ts); age this one past it so the sweep treats
    // it as the real orphan the channel deletion made it.
    await tdb
      .update(files)
      .set({ createdAt: Date.now() - ORPHAN_GRACE_MS - 1 })
      .where(eq(files.id, dbFile!.id));

    // load crons here, it will run the file cleanup cron job
    await loadCrons();

    await Bun.sleep(1000); // wait a bit for cron to finish

    const [afterDbFile] = await tdb
      .select()
      .from(files)
      .where(eq(files.id, dbFile!.id))
      .limit(1);

    // file record is deleted
    expect(afterDbFile).toBeUndefined();

    // file is deleted from disk
    expect(await fileExists(path.join(PUBLIC_PATH, dbFile!.name))).toBe(false);
  });

  test('should return 403 when trying to access a private channel file without token', async () => {
    const { token } = await setup();
    const { caller } = await initTest();

    const channelId = await caller.channels.add({
      name: 'Private Channel',
      categoryId: 1,
      type: ChannelType.TEXT,
      serverId: 1
    });

    await caller.channels.update({
      channelId: channelId,
      private: true
    });

    const [channel] = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    expect(channel).toBeDefined();
    expect(channel?.private).toBe(true);

    const tempFile = await upload(
      new File(['Private file content'], 'private-file.txt', {
        type: 'text/plain'
      }),
      token
    );

    const messageId = await caller.messages.send({
      content: 'Message with private file',
      channelId,
      files: [tempFile.id]
    });

    const dbFile = await getFileByMessageId(messageId);

    expect(dbFile).toBeDefined();

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}`
    );

    expect(response.status).toBe(403);

    const data = (await response.json()) as { error: string };

    expect(data).toHaveProperty('error', 'Forbidden');
  });

  test('should return 403 when trying to access a private channel file with invalid token', async () => {
    const { token } = await setup();
    const { caller } = await initTest();

    const channelId = await caller.channels.add({
      name: 'Private Channel',
      categoryId: 1,
      type: ChannelType.TEXT,
      serverId: 1
    });

    await caller.channels.update({
      channelId: channelId,
      private: true
    });

    const tempFile = await upload(
      new File(['Private file content'], 'private-file.txt', {
        type: 'text/plain'
      }),
      token
    );

    const messageId = await caller.messages.send({
      content: 'Message with private file',
      channelId,
      files: [tempFile.id]
    });

    const dbFile = await getFileByMessageId(messageId);

    expect(dbFile).toBeDefined();

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}?accessToken=invalid-token-xyz`
    );

    expect(response.status).toBe(403);

    const data = (await response.json()) as { error: string };

    expect(data).toHaveProperty('error', 'Forbidden');
  });

  test('should return 200 when accessing a private channel file with valid token', async () => {
    const { token } = await setup();
    const { caller } = await initTest();

    const channelId = await caller.channels.add({
      name: 'Private Channel',
      categoryId: 1,
      type: ChannelType.TEXT,
      serverId: 1
    });

    await caller.channels.update({
      channelId: channelId,
      private: true
    });

    const [channel] = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    expect(channel).toBeDefined();
    expect(channel?.private).toBe(true);
    expect(channel?.fileAccessToken).toBeDefined();

    const fileContent = 'Private file content';
    const tempFile = await upload(
      new File([fileContent], 'private-file.txt', {
        type: 'text/plain'
      }),
      token
    );

    const messageId = await caller.messages.send({
      content: 'Message with private file',
      channelId,
      files: [tempFile.id]
    });

    const dbFile = await getFileByMessageId(messageId);

    expect(dbFile).toBeDefined();

    const validToken = generateFileToken(dbFile!.id, channel!.fileAccessToken);
    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}?accessToken=${validToken}`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'application/octet-stream'
    );

    const responseText = await response.text();

    expect(responseText).toBe(fileContent);
  });

  test('should return 403 when using token from different channel', async () => {
    const { token } = await setup();
    const { caller } = await initTest();

    const channelId1 = await caller.channels.add({
      name: 'Private Chan 1',
      categoryId: 1,
      type: ChannelType.TEXT,
      serverId: 1
    });

    await caller.channels.update({
      channelId: channelId1,
      private: true
    });

    const channelId2 = await caller.channels.add({
      name: 'Private Chan 2',
      categoryId: 1,
      type: ChannelType.TEXT,
      serverId: 1
    });

    await caller.channels.update({
      channelId: channelId2,
      private: true
    });

    const [channel1] = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, channelId1))
      .limit(1);

    const [channel2] = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, channelId2))
      .limit(1);

    expect(channel1).toBeDefined();
    expect(channel2).toBeDefined();
    expect(channel1?.fileAccessToken).not.toBe(channel2?.fileAccessToken);

    const tempFile = await upload(
      new File(['Private file content'], 'private-file.txt', {
        type: 'text/plain'
      }),
      token
    );

    const messageId = await caller.messages.send({
      content: 'Message with private file',
      channelId: channelId1,
      files: [tempFile.id]
    });

    const dbFile = await getFileByMessageId(messageId);

    expect(dbFile).toBeDefined();

    const wrongChannelToken = generateFileToken(
      dbFile!.id,
      channel2!.fileAccessToken
    );

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}?accessToken=${wrongChannelToken}`
    );

    expect(response.status).toBe(403);

    const data = (await response.json()) as { error: string };

    expect(data).toHaveProperty('error', 'Forbidden');
  });

  test('should allow access to public channel files without token', async () => {
    const { token } = await setup();
    const { caller } = await initTest();

    const channelId = await caller.channels.add({
      name: 'Public Channel',
      categoryId: 1,
      type: ChannelType.TEXT,
      serverId: 1
    });

    const [channel] = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    expect(channel).toBeDefined();
    expect(channel?.private).toBe(false);

    const fileContent = 'Public file content';
    const tempFile = await upload(
      new File([fileContent], 'public-file.txt', {
        type: 'text/plain'
      }),
      token
    );

    const messageId = await caller.messages.send({
      content: 'Message with public file',
      channelId,
      files: [tempFile.id]
    });

    const dbFile = await getFileByMessageId(messageId);

    expect(dbFile).toBeDefined();

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}`
    );

    expect(response.status).toBe(200);

    const responseText = await response.text();

    expect(responseText).toBe(fileContent);
  });

  test('DM attachment is 403 without a token and 200 with the DM token', async () => {
    // A DM attachment previously fell through to the fully-public branch
    // (getMessageByFileId only covers server messages) and was served
    // with no check. Now it's gated behind the DM file token. The serve
    // path checks only the token, so a direct DB setup exercises it.
    const now = Date.now();
    const [dmChannel] = await tdb
      .insert(dmChannels)
      .values({ createdAt: now })
      .returning();
    const [dmMessage] = await tdb
      .insert(dmMessages)
      .values({
        dmChannelId: dmChannel!.id,
        userId: 1,
        content: 'dm with a private file',
        createdAt: now
      })
      .returning();

    const fileName = `dm-attachment-${now}.txt`;
    const fileContent = 'secret DM attachment content';
    await fs.writeFile(path.join(PUBLIC_PATH, fileName), fileContent);

    const [dbFile] = await tdb
      .insert(files)
      .values({
        name: fileName,
        originalName: 'secret.txt',
        md5: `dm-md5-${now}`,
        userId: 1,
        size: fileContent.length,
        mimeType: 'text/plain',
        extension: '.txt',
        createdAt: now
      })
      .returning();

    await tdb.insert(dmMessageFiles).values({
      dmMessageId: dmMessage!.id,
      fileId: dbFile!.id,
      createdAt: now
    });

    try {
      // No token → 403 (was 200 before the fix).
      const noToken = await fetch(
        `${testsBaseUrl}/public/${encodeURIComponent(fileName)}`
      );
      expect(noToken.status).toBe(403);

      // Wrong token → 403.
      const wrong = await fetch(
        `${testsBaseUrl}/public/${encodeURIComponent(fileName)}?accessToken=nope`
      );
      expect(wrong.status).toBe(403);

      // Correct DM token → 200.
      const validToken = generateFileToken(
        dbFile!.id,
        dmFileSalt(dmChannel!.id)
      );
      const ok = await fetch(
        `${testsBaseUrl}/public/${encodeURIComponent(fileName)}?accessToken=${validToken}`
      );
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe(fileContent);
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, fileName), { force: true });
    }
  });

  /**
   * A private channel in server 1 with one attachment sent by the owner.
   * Returns everything the token tests need: the file row, the channel
   * salt and the caller.
   */
  const seedPrivateAttachment = async () => {
    const { token } = await setup();
    const { caller } = await initTest();

    const channelId = await caller.channels.add({
      name: 'Private Channel',
      categoryId: 1,
      type: ChannelType.TEXT,
      serverId: 1
    });

    await caller.channels.update({ channelId, private: true });

    const tempFile = await upload(
      new File(['Private file content'], 'private-file.txt', {
        type: 'text/plain'
      }),
      token
    );

    const messageId = await caller.messages.send({
      content: 'Message with private file',
      channelId,
      files: [tempFile.id]
    });

    const dbFile = (await getFileByMessageId(messageId))!;
    const [channel] = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    return { caller, channelId, dbFile, salt: channel!.fileAccessToken };
  };

  const fileUrl = (name: string, accessToken?: string) =>
    `${testsBaseUrl}/public/${encodeURIComponent(name)}` +
    (accessToken ? `?accessToken=${accessToken}` : '');

  test('an expired private-channel token is refused; a live one is served with a private cache policy', async () => {
    const { dbFile, salt } = await seedPrivateAttachment();

    const expired = generateFileToken(
      dbFile.id,
      salt,
      Date.now() - FILE_TOKEN_MAX_TTL_MS - 1
    );
    const refused = await fetch(fileUrl(dbFile.name, expired));

    expect(refused.status).toBe(403);
    expect(refused.headers.get('Content-Security-Policy')).toBe(PUBLIC_CSP);
    expect(refused.headers.get('Accept-Ranges')).toBe('bytes');

    const live = generateFileToken(dbFile.id, salt);
    const served = await fetch(fileUrl(dbFile.name, live));

    expect(served.status).toBe(200);
    expect(served.headers.get('Cache-Control')).toBe(CACHE_PRIVATE);
    expect(served.headers.get('ETag')).toBe(`"${dbFile.name}"`);
    expect(served.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await served.text()).toBe('Private file content');
  });

  test('a public file is served immutable with an ETag and revalidates to an empty 304', async () => {
    const dbFile = await seedStoredFile({
      name: `cached-${Date.now()}.png`,
      originalName: 'cached.png',
      mimeType: 'image/png',
      content: 'png-bytes'
    });

    try {
      const first = await fetch(fileUrl(dbFile.name));

      expect(first.status).toBe(200);
      expect(first.headers.get('Cache-Control')).toBe(CACHE_PUBLIC);
      expect(first.headers.get('ETag')).toBe(`"${dbFile.name}"`);
      expect(first.headers.get('Accept-Ranges')).toBe('bytes');
      expect(await first.text()).toBe('png-bytes');

      const revalidated = await fetch(fileUrl(dbFile.name), {
        headers: { 'If-None-Match': `"${dbFile.name}"` }
      });

      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');
      expect(revalidated.headers.get('ETag')).toBe(`"${dbFile.name}"`);
      expect(revalidated.headers.get('Cache-Control')).toBe(CACHE_PUBLIC);
      expect(revalidated.headers.get('Content-Security-Policy')).toBe(
        PUBLIC_CSP
      );
      expect(revalidated.headers.get('X-Content-Type-Options')).toBe(
        'nosniff'
      );
      expect(revalidated.headers.get('Content-Disposition')).toBe(
        'inline; filename="cached.png"'
      );

      // A tag for some other representation is not a match.
      const other = await fetch(fileUrl(dbFile.name), {
        headers: { 'If-None-Match': '"something-else"' }
      });

      expect(other.status).toBe(200);
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, dbFile.name), { force: true });
    }
  });

  test('a private file revalidates to 304 only with a valid token', async () => {
    const { dbFile, salt } = await seedPrivateAttachment();
    const live = generateFileToken(dbFile.id, salt);

    const withToken = await fetch(fileUrl(dbFile.name, live), {
      headers: { 'If-None-Match': `"${dbFile.name}"` }
    });

    expect(withToken.status).toBe(304);

    const withoutToken = await fetch(fileUrl(dbFile.name), {
      headers: { 'If-None-Match': `"${dbFile.name}"` }
    });

    expect(withoutToken.status).toBe(403);
  });

  test('Range requests get the exact slice, a suffix, a clamp, a 416 or the whole file', async () => {
    const content = '0123456789abcdefghij';
    const dbFile = await seedStoredFile({
      name: `clip-${Date.now()}.mp4`,
      originalName: 'clip.mp4',
      mimeType: 'video/mp4',
      content
    });

    const ranged = (range: string) =>
      fetch(fileUrl(dbFile.name), { headers: { Range: range } });

    try {
      const head = await ranged('bytes=0-4');

      expect(head.status).toBe(206);
      expect(head.headers.get('Content-Range')).toBe('bytes 0-4/20');
      expect(head.headers.get('Content-Length')).toBe('5');
      expect(head.headers.get('Content-Type')).toBe('video/mp4');
      expect(head.headers.get('Content-Disposition')).toBe(
        'inline; filename="clip.mp4"'
      );
      expect(head.headers.get('Content-Security-Policy')).toBe(PUBLIC_CSP);
      expect(head.headers.get('Cache-Control')).toBe(CACHE_PUBLIC);
      expect(await head.text()).toBe('01234');

      const open = await ranged('bytes=15-');

      expect(open.status).toBe(206);
      expect(open.headers.get('Content-Range')).toBe('bytes 15-19/20');
      expect(await open.text()).toBe('fghij');

      const suffix = await ranged('bytes=-5');

      expect(suffix.status).toBe(206);
      expect(suffix.headers.get('Content-Range')).toBe('bytes 15-19/20');
      expect(await suffix.text()).toBe('fghij');

      const clamped = await ranged('bytes=5-100');

      expect(clamped.status).toBe(206);
      expect(clamped.headers.get('Content-Range')).toBe('bytes 5-19/20');
      expect(await clamped.text()).toBe('56789abcdefghij');

      const past = await ranged('bytes=20-');

      expect(past.status).toBe(416);
      expect(past.headers.get('Content-Range')).toBe('bytes */20');
      expect(past.headers.get('Content-Security-Policy')).toBe(PUBLIC_CSP);
      expect(past.headers.get('Content-Disposition')).toBe(
        'inline; filename="clip.mp4"'
      );

      const inverted = await ranged('bytes=9-3');

      expect(inverted.status).toBe(416);

      const emptySuffix = await ranged('bytes=-0');

      expect(emptySuffix.status).toBe(416);

      for (const ignored of ['bytes=0-2,4-5', 'bytes=abc', 'items=0-4']) {
        const whole = await ranged(ignored);

        expect(whole.status).toBe(200);
        expect(whole.headers.get('Content-Range')).toBeNull();
        expect(whole.headers.get('Content-Length')).toBe('20');
        expect(await whole.text()).toBe(content);
      }

      // If-Range naming a different entity: the partial copy is not
      // ours, so the whole file goes out.
      const staleIfRange = await fetch(fileUrl(dbFile.name), {
        headers: { Range: 'bytes=0-4', 'If-Range': '"someone-else"' }
      });

      expect(staleIfRange.status).toBe(200);
      expect(await staleIfRange.text()).toBe(content);
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, dbFile.name), { force: true });
    }
  });

  test('a private attachment honours Range with a valid token and refuses it without', async () => {
    const { dbFile, salt } = await seedPrivateAttachment();
    const live = generateFileToken(dbFile.id, salt);

    const slice = await fetch(fileUrl(dbFile.name, live), {
      headers: { Range: 'bytes=0-6' }
    });

    expect(slice.status).toBe(206);
    expect(slice.headers.get('Cache-Control')).toBe(CACHE_PRIVATE);
    expect(await slice.text()).toBe('Private');

    const refused = await fetch(fileUrl(dbFile.name), {
      headers: { Range: 'bytes=0-6' }
    });

    expect(refused.status).toBe(403);
  });

  test('the association is memoised per file; removeFile drops the entry', async () => {
    const dbFile = await seedStoredFile({
      name: `memo-${Date.now()}.png`,
      originalName: 'memo.png',
      mimeType: 'image/png',
      content: 'png-bytes'
    });
    const orphanCheck = spyOn(filesQueries, 'isFileOrphaned');

    try {
      expect((await fetch(fileUrl(dbFile.name))).status).toBe(200);
      expect(orphanCheck).toHaveBeenCalledTimes(1);

      // Second hit: the files row, orphan check and link lookups are
      // all skipped.
      expect((await fetch(fileUrl(dbFile.name))).status).toBe(200);
      expect(orphanCheck).toHaveBeenCalledTimes(1);

      await removeFile(dbFile.id);

      // Without invalidation the stale entry would reach the disk check
      // and answer "not found on disk"; a dropped entry misses the
      // files row first.
      const gone = await fetch(fileUrl(dbFile.name));

      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual({ error: 'File not found' });
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, dbFile.name), { force: true });
    }
  });

  test('a memoised channel attachment is refused as soon as its channel is gone', async () => {
    const dbFile = await seedStoredFile({
      name: `doomed-${Date.now()}.png`,
      originalName: 'doomed.png',
      mimeType: 'image/png',
      content: 'png-bytes'
    });

    try {
      expect((await fetch(fileUrl(dbFile.name))).status).toBe(200);

      const { caller } = await initTest();

      await caller.channels.delete({ channelId: 1 });

      const gone = await fetch(fileUrl(dbFile.name));

      expect(gone.status).toBe(404);
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, dbFile.name), { force: true });
    }
  });

  test('a salt rotation bites on the next request although the association is memoised', async () => {
    const { caller, channelId, dbFile, salt } = await seedPrivateAttachment();
    const before = generateFileToken(dbFile.id, salt);

    expect((await fetch(fileUrl(dbFile.name, before))).status).toBe(200);

    await caller.channels.rotateFileAccessToken({ channelId });

    expect((await fetch(fileUrl(dbFile.name, before))).status).toBe(403);

    const [rotated] = await tdb
      .select({ fileAccessToken: channels.fileAccessToken })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    const after = generateFileToken(dbFile.id, rotated!.fileAccessToken);

    expect((await fetch(fileUrl(dbFile.name, after))).status).toBe(200);
  });

  test('should allow access to non-message files without token', async () => {
    const { filesToCreate } = await setup();
    const file = filesToCreate[0];

    expect(file).toBeDefined();
    expect(file!.messageId).toBeDefined();

    const dbFile = await getFileByMessageId(file!.messageId!);

    expect(dbFile).toBeDefined();

    const response = await fetch(
      `${testsBaseUrl}/public/${encodeURIComponent(dbFile!.name)}`
    );

    expect(response.status).toBe(200);

    const responseText = await response.text();

    expect(responseText).toBe(file!.content);
  });
});
