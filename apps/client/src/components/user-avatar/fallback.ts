/**
 * The avatar placeholder every surface paints when a person has no
 * picture: initials over a gradient that is the same for that person
 * everywhere — roster, DM list, reaction hover, permission overrides.
 *
 * Kept free of React and Redux so the surfaces that render from plain
 * data (DM channel members, reactors) can use it too.
 */
import { hash32 } from '@/lib/hash';
import { cn } from '@/lib/utils';

const avatarGradients = [
  'from-violet-600 to-indigo-600',
  'from-rose-500 to-orange-500',
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-cyan-500',
  'from-fuchsia-500 to-pink-500',
  'from-amber-500 to-yellow-500',
  'from-sky-500 to-blue-600',
  'from-red-500 to-rose-600'
];

/** One of the gradients, stable for the seed. */
const avatarGradientClass = (seed: string): string =>
  avatarGradients[hash32(seed) % avatarGradients.length];

/**
 * Fallback classes for a person. Keyed on the publicId — the identity
 * every instance agrees on — so a federated member looks the same here
 * and on their home instance. Numeric ids are per-instance and only
 * seed the gradient when no publicId is known (a reactor who left).
 */
const avatarFallbackClass = (user: {
  publicId?: string | null;
  id: number;
}): string =>
  cn(
    'text-white bg-gradient-to-br',
    avatarGradientClass(user.publicId || `id:${user.id}`)
  );

/** Fallback classes for a group conversation's icon. */
const groupAvatarFallbackClass = (dmChannelId: number): string =>
  cn('text-white bg-gradient-to-br', avatarGradientClass(`group:${dmChannelId}`));

export { avatarFallbackClass, groupAvatarFallbackClass };
