import {
  SOUND_EMOJI_MAX_LENGTH,
  SOUND_MAX_FILE_BYTES,
  SOUND_NAME_MAX_LENGTH
} from '@pulse/shared';
import path from 'path';
import { z } from 'zod';
import type { TTempFile } from '@pulse/shared';

const soundNameSchema = z.string().trim().min(1).max(SOUND_NAME_MAX_LENGTH);
const soundEmojiSchema = z.string().trim().min(1).max(SOUND_EMOJI_MAX_LENGTH);
const soundVolumeSchema = z.number().int().min(0).max(100);

/**
 * Container formats browsers decode (the clip is played by the clients,
 * so "what Bun thinks the type is" matters less than "what a browser
 * will play"). The extension is the first gate; the sniffed type the
 * second, with .webm/.weba allowed under video/* because a recorded
 * audio clip carries that container.
 */
const SOUND_EXTENSIONS = new Set([
  '.mp3',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.webm',
  '.weba'
]);

/**
 * Why an uploaded temp file is not a soundboard clip, or null when it
 * is. The server has no decoder, so the duration is the client's check
 * (decodeAudioData before upload); the size here is the hard stop that
 * keeps a 5 s cap honest in practice.
 */
const soundFileRejection = (
  tempFile: TTempFile,
  sniffedType: string
): string | null => {
  if (tempFile.encrypted) return 'Encrypted files cannot be sounds';
  if (tempFile.size > SOUND_MAX_FILE_BYTES) {
    return `Sounds may be at most ${Math.round(SOUND_MAX_FILE_BYTES / 1024)} KB`;
  }

  const ext = path.extname(tempFile.originalName).toLowerCase();
  if (!SOUND_EXTENSIONS.has(ext)) return 'Not an audio file';

  const isWebm = ext === '.webm' || ext === '.weba';
  if (!sniffedType.startsWith('audio/') && !(isWebm && sniffedType.startsWith('video/'))) {
    return 'Not an audio file';
  }

  return null;
};

export { soundEmojiSchema, soundFileRejection, soundNameSchema, soundVolumeSchema };
