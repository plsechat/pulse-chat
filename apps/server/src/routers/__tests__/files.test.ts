import type { TTempFile } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import { initTest, login, uploadFile } from '../../__tests__/helpers';
import { fileExists, fileManager } from '../../utils/file-manager';

// Called inside each test (not beforeEach) so the upload doesn't pile
// onto the global per-test TRUNCATE inside the same hook budget.
const uploadTempFile = async (): Promise<TTempFile> => {
  const response = await login('testowner', 'password123');
  const data = (await response.json()) as { accessToken: string };

  const res = await uploadFile(
    new File(['test'], `file-${randomUUIDv7().slice(0, 8)}.txt`, {
      type: 'text/plain'
    }),
    data.accessToken
  );

  return (await res.json()) as TTempFile;
};

describe('files router', () => {
  test('should check temporary file existence', async () => {
    const tempFile = await uploadTempFile();
    expect(tempFile).toBeDefined();
    expect(tempFile.id).toBeDefined();

    const file = await fileManager.getTemporaryFile(tempFile.id);

    expect(file).toBeDefined();
    expect(file?.path).toBe(tempFile.path);
    expect(file?.originalName).toBe(tempFile.originalName);
    expect(file?.size).toBe(tempFile.size);

    const stat = await fs.stat(tempFile.path);

    expect(stat.size).toBe(tempFile.size);
  });

  test('should delete a temporary file', async () => {
    const tempFile = await uploadTempFile();
    const { caller } = await initTest();

    expect(await fileExists(tempFile.path)).toBe(true);

    await caller.files.deleteTemporary({
      fileId: tempFile.id
    });

    expect(await fileExists(tempFile.path)).toBe(false);
  });

  test('should throw when deleting a non-existent temporary file', async () => {
    const { caller } = await initTest();

    await expect(
      caller.files.deleteTemporary({
        fileId: '<non-existent-file-id>' // non-existent file ID
      })
    ).rejects.toThrow('Temporary file not found');
  });

  test('should throw when deleting other users temporary file', async () => {
    const tempFile = await uploadTempFile();
    const { caller } = await initTest(2);

    await expect(
      caller.files.deleteTemporary({
        fileId: tempFile.id
      })
    ).rejects.toThrow(
      'You do not have permission to delete this temporary file'
    );

    expect(await fileExists(tempFile.path)).toBe(true);
  });
});
