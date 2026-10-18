import {
  StorageOverflowAction,
  UploadHeaders,
  type TTempFile
} from '@pulse/shared';
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test
} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'path';
import { login, uploadFile } from '../../__tests__/helpers';
import { tdb, testsBaseUrl } from '../../__tests__/setup';
import { servers } from '../../db/schema';
import { TMP_PATH } from '../../helpers/paths';
import { fileExists, fileManager } from '../../utils/file-manager';

const getMockFile = (content: string): File => {
  const blob = new Blob([content], { type: 'text/plain' });

  return new File([blob], 'test-upload.txt', { type: 'text/plain' });
};

// Called inside each test (not beforeEach) so the login's DB writes
// don't pile onto the global per-test TRUNCATE inside the same hook
// budget.
const loginOwner = async (): Promise<string> => {
  const response = await login('testowner', 'password123');
  const data = (await response.json()) as { accessToken: string };

  return data.accessToken;
};

describe('/upload', () => {
  afterAll(async () => {
    const files = await fs.readdir(TMP_PATH);

    for (const file of files) {
      await fs.unlink(path.join(TMP_PATH, file));
    }
  });

  afterEach(() => {
    mock.restore();
  });

  // Declared first on purpose: the sweep runs once per process, before
  // the first upload touches disk, so this must be the first test in
  // the file that uploads anything.
  test('should upload a file successfully', async () => {
    const token = await loginOwner();
    const file = getMockFile('Hello, this is a test file for upload.');
    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    const expectedPath = path.join(TMP_PATH, `${data.id}${data.extension}`);

    expect(data).toBeDefined();
    expect(data.id).toBeDefined();
    expect(data.originalName).toBe(file.name);
    expect(data.size).toBe(file.size);
    expect(data.md5).toBeDefined();
    expect(data.extension).toBe('.txt');
    expect(data.userId).toBe(1);
    expect(data.path).toBe(expectedPath);

    expect(await fileExists(expectedPath)).toBe(true);
    expect(await fs.readFile(expectedPath, 'utf-8')).toBe(
      'Hello, this is a test file for upload.'
    );
    expect((await fs.stat(expectedPath)).size).toBe(file.size);
  });

  test('should throw when upload headers are missing', async () => {
    const file = getMockFile('This upload will fail due to missing headers.');
    const response = await fetch(`${testsBaseUrl}/upload`, {
      method: 'POST',
      body: file
    });

    expect(response.status).toBe(400);

    const data = (await response.json()) as { errors: Record<string, string> };

    expect(data).toHaveProperty('errors');
    expect(data.errors[UploadHeaders.TOKEN]).toBeDefined();
    expect(data.errors[UploadHeaders.ORIGINAL_NAME]).toBeDefined();
  });

  test('should throw when upload token is invalid', async () => {
    const file = getMockFile('This upload will fail due to invalid token.');
    const response = await uploadFile(file, 'invalid-token');

    expect(response.status).toBe(401);

    const data = (await response.json()) as Record<string, unknown>;

    expect(data).toHaveProperty('error', 'Unauthorized');
  });

  test('should throw when uploads are disabled', async () => {
    const token = await loginOwner();
    await tdb.update(servers).set({ storageUploadEnabled: false });

    const file = getMockFile('gonna fail');
    const response = await uploadFile(file, token);

    expect(response.status).toBe(403);

    const data = (await response.json()) as Record<string, unknown>;

    expect(data).toHaveProperty(
      'error',
      'File uploads are disabled on this server'
    );
  });

  test('should throw when file exceeds max size', async () => {
    const token = await loginOwner();
    await tdb
      .update(servers)
      .set({ storageUploadMaxFileSize: 5 * 1024 * 1024 }); // 5 MB

    const largeContent = 'A'.repeat(5 * 1024 * 1024 + 1); // 5 MB + 1 byte
    const file = getMockFile(largeContent);
    const response = await uploadFile(file, token);

    expect(response.status).toBe(413);

    const data = (await response.json()) as Record<string, unknown>;

    expect(data).toHaveProperty(
      'error',
      `File ${file.name} exceeds the maximum allowed size`
    );
  });

  test('should handle files with special characters in name', async () => {
    const token = await loginOwner();
    const specialContent = 'File with special name';
    const blob = new Blob([specialContent], { type: 'text/plain' });
    const file = new File([blob], 'test file (1) [copy].txt', {
      type: 'text/plain'
    });

    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.originalName).toBe('test file (1) [copy].txt');
    expect(await fileExists(data.path)).toBe(true);
  });

  test('rejects empty files with 400 before touching disk', async () => {
    const token = await loginOwner();
    const blob = new Blob([], { type: 'text/plain' });
    const file = new File([blob], 'empty.txt', { type: 'text/plain' });
    const safePathSpy = spyOn(fileManager, 'getSafeUploadPath');

    const response = await uploadFile(file, token);

    expect(response.status).toBe(400);

    const data = (await response.json()) as Record<string, unknown>;

    expect(data).toHaveProperty('error', 'Empty files cannot be uploaded');
    expect(safePathSpy).not.toHaveBeenCalled();
  });

  test('rejects an upload over the user quota with 413 before any bytes are written', async () => {
    const token = await loginOwner();
    await tdb.update(servers).set({ storageSpaceQuotaByUser: 10 });

    const safePathSpy = spyOn(fileManager, 'getSafeUploadPath');
    const response = await uploadFile(
      getMockFile('twenty bytes of data'),
      token
    );

    expect(response.status).toBe(413);

    const data = (await response.json()) as Record<string, unknown>;

    expect(data).toHaveProperty('error', 'User storage limit exceeded');
    // No upload path was ever allocated, so no write stream was opened.
    expect(safePathSpy).not.toHaveBeenCalled();
  });

  test('rejects an upload over the server quota with 413 when overflow action is PREVENT_UPLOADS', async () => {
    const token = await loginOwner();
    await tdb.update(servers).set({
      storageQuota: 10,
      storageOverflowAction: StorageOverflowAction.PREVENT_UPLOADS
    });

    const safePathSpy = spyOn(fileManager, 'getSafeUploadPath');
    const response = await uploadFile(
      getMockFile('twenty bytes of data'),
      token
    );

    expect(response.status).toBe(413);

    const data = (await response.json()) as Record<string, unknown>;

    expect(data).toHaveProperty('error', 'Server storage limit exceeded.');
    expect(safePathSpy).not.toHaveBeenCalled();
  });

  test('accepts an upload over the server quota when overflow action is DELETE_OLD_FILES', async () => {
    // saveFile frees the space in this mode, so intake must not refuse.
    const token = await loginOwner();
    await tdb.update(servers).set({
      storageQuota: 10,
      storageOverflowAction: StorageOverflowAction.DELETE_OLD_FILES
    });

    const response = await uploadFile(
      getMockFile('twenty bytes of data'),
      token
    );

    expect(response.status).toBe(200);
  });

  test('rejects scriptable extensions the denylist used to miss', async () => {
    const token = await loginOwner();

    for (const name of [
      'page.shtml',
      'page.SHTML',
      'script.ts',
      'script.tsx',
      'doc.xht',
      'img.svgz',
      'app.webmanifest'
    ]) {
      const file = new File([new Blob(['<script>alert(1)</script>'])], name, {
        type: 'text/plain'
      });
      const response = await uploadFile(file, token);

      expect(response.status).toBe(400);

      const data = (await response.json()) as Record<string, unknown>;

      expect(data).toHaveProperty(
        'error',
        `File type ${path.extname(name).toLowerCase()} is not allowed`
      );
    }
  });

  test('a 5000-character extension is dropped and the on-disk name stays short', async () => {
    const token = await loginOwner();
    const longName = 'a.' + 'x'.repeat(5000);
    const file = new File([new Blob(['content'])], longName, {
      type: 'text/plain'
    });

    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    // The header value itself is bounded by the HTTP layer, so only the
    // prefix is asserted; what matters is that none of it reaches disk.
    expect(data.originalName.startsWith('a.xxxx')).toBe(true);
    expect(data.extension).toBe('');
    expect(path.basename(data.path)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await fileExists(data.path)).toBe(true);
  });

  test('the stored extension is lower-cased and limited to [a-z0-9]', async () => {
    const token = await loginOwner();
    const file = new File([new Blob(['content'])], 'photo.PNG', {
      type: 'image/png'
    });

    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.extension).toBe('.png');
    expect(path.basename(data.path)).toMatch(/^[0-9a-f-]{36}\.png$/i);
  });

  test('should handle different file types', async () => {
    const token = await loginOwner();
    // Test with a JSON file
    const jsonContent = JSON.stringify({ test: true });
    const jsonBlob = new Blob([jsonContent], { type: 'application/json' });
    const jsonFile = new File([jsonBlob], 'data.json', {
      type: 'application/json'
    });

    const response = await uploadFile(jsonFile, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.extension).toBe('.json');
    expect(data.originalName).toBe('data.json');
    expect(await fileExists(data.path)).toBe(true);
  });

  test('should handle files with no extension', async () => {
    const token = await loginOwner();
    const blob = new Blob(['Makefile content'], { type: 'text/plain' });
    const file = new File([blob], 'Makefile', { type: 'text/plain' });

    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.originalName).toBe('Makefile');
    expect(await fileExists(data.path)).toBe(true);
  });

  test('should handle files with multiple dots in name', async () => {
    const token = await loginOwner();
    const blob = new Blob(['backup content'], { type: 'text/plain' });
    const file = new File([blob], 'file.backup.old.txt', {
      type: 'text/plain'
    });

    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.originalName).toBe('file.backup.old.txt');
    expect(data.extension).toBe('.txt');
  });

  test('should handle very long filenames', async () => {
    const token = await loginOwner();
    const longName = 'a'.repeat(200) + '.txt';
    const blob = new Blob(['content'], { type: 'text/plain' });
    const file = new File([blob], longName, { type: 'text/plain' });

    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.originalName).toBe(longName);
    expect(await fileExists(data.path)).toBe(true);
  });

  test('should upload multiple files sequentially', async () => {
    const token = await loginOwner();
    const file1 = getMockFile('First file content');
    const file2 = getMockFile('Second file content');

    const response1 = await uploadFile(file1, token);
    expect(response1.status).toBe(200);
    const data1 = (await response1.json()) as TTempFile;

    const response2 = await uploadFile(file2, token);
    expect(response2.status).toBe(200);
    const data2 = (await response2.json()) as TTempFile;

    expect(data1.id).not.toBe(data2.id);
    expect(await fileExists(data1.path)).toBe(true);
    expect(await fileExists(data2.path)).toBe(true);
  });

  test('should generate unique MD5 hashes for different files', async () => {
    const token = await loginOwner();
    const file1 = getMockFile('Content A');
    const file2 = getMockFile('Content B');

    const response1 = await uploadFile(file1, token);
    const data1 = (await response1.json()) as TTempFile;

    const response2 = await uploadFile(file2, token);
    const data2 = (await response2.json()) as TTempFile;

    expect(data1.md5).not.toBe(data2.md5);
  });

  test('should set correct userId for uploaded file', async () => {
    const token = await loginOwner();
    const file = getMockFile('User association test');
    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.userId).toBe(1); // testowner has ID 1
  });

  test('should handle binary files correctly', async () => {
    const token = await loginOwner();
    // Create a small binary file (simulating an image)
    const binaryData = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
    const blob = new Blob([binaryData], { type: 'image/png' });
    const file = new File([blob], 'image.png', { type: 'image/png' });

    const response = await uploadFile(file, token);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TTempFile;

    expect(data.extension).toBe('.png');
    expect(data.size).toBe(8);
    expect(await fileExists(data.path)).toBe(true);
  });
});
