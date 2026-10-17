import { createContext, useContext } from 'react';

/**
 * The soundboard context object and its hooks, apart from the provider
 * component so the provider file exports components only (react
 * refresh) while the tile and the grid read the same context.
 */

export type TSoundRipple = {
  soundId: number;
  name: string;
  emoji: string | null;
  at: number;
};

export type TSoundboardContext = {
  /** Trigger a clip in the current room (the server fans it out, including to us). */
  playSound: (soundId: number) => Promise<boolean>;
  /** Per player: the clip they last triggered, while its ripple runs. */
  ripples: Record<number, TSoundRipple>;
};

export const SoundboardContext = createContext<TSoundboardContext>({
  playSound: () => Promise.resolve(false),
  ripples: {}
});

export const useSoundboard = () => useContext(SoundboardContext);

/** The ripple to draw on `userId`'s tile right now, if any. */
export const useSoundRipple = (userId: number): TSoundRipple | undefined =>
  useContext(SoundboardContext).ripples[userId];
