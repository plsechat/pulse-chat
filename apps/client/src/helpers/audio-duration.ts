/**
 * Decode an audio file in the browser to learn how long it plays. The
 * server has no decoder, so this is THE length check for soundboard
 * clips (the server enforces the byte size). Rejects when the browser
 * cannot decode the file — which also means it could not play it.
 */
export const probeAudioDuration = async (file: File): Promise<number> => {
  const Ctor =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) throw new Error('This browser cannot decode audio');

  const ctx = new Ctor();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    return buffer.duration;
  } finally {
    void ctx.close().catch(() => {});
  }
};
