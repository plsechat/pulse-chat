import { Permission } from '@pulse/shared';

/**
 * Every per-server section of the Server Settings screen and the single
 * permission that unlocks it. The settings shell builds its nav from
 * this map and the left-sidebar menu entry gates on the derived list
 * below, so a section can never exist without a way to reach it (the
 * old hand-written sidebar list omitted reports/webhooks/automod and
 * still carried two dead permissions).
 *
 * Instance sections (All Accounts, Health, Plugins, ...) are not here:
 * they are the instance owner's alone and gated on identity, not on a
 * role permission — see ServerSettings and `canOpenServerSettings`.
 */
export const SECTION_PERMISSIONS = {
  general: Permission.MANAGE_SETTINGS,
  roles: Permission.MANAGE_ROLES,
  users: Permission.MANAGE_USERS,
  invites: Permission.MANAGE_INVITES,
  reports: Permission.VIEW_REPORTS,
  emojis: Permission.MANAGE_EMOJIS,
  nameplates: Permission.MANAGE_EMOJIS,
  webhooks: Permission.MANAGE_WEBHOOKS,
  automod: Permission.MANAGE_AUTOMOD,
  events: Permission.MANAGE_EVENTS
} as const satisfies Record<string, Permission>;

export type TPermissionedSection = keyof typeof SECTION_PERMISSIONS;

/**
 * Sections for the SERVER OWNER alone, gated on identity rather than a
 * role permission: the community import rewrites the server's name
 * and icon and mints members. An owner satisfies every permission in
 * `can()`, so the menu entry needs no extra term below.
 */
export const OWNER_SECTIONS = ['import'] as const;

export type TOwnerSection = (typeof OWNER_SECTIONS)[number];

/** ANY-of list for the "Server Settings" menu entry — derived, never typed twice. */
export const SERVER_SETTINGS_PERMISSIONS: Permission[] = [
  ...new Set(Object.values(SECTION_PERMISSIONS))
];

/**
 * Whether the Server Settings screen has at least one section for this
 * user: any gated section's permission, or the Instance group (instance
 * owner on the home instance — no server permission required).
 */
export const canOpenServerSettings = (
  can: (permission: Permission | Permission[]) => boolean,
  isInstanceOwner: boolean,
  activeInstanceDomain: string | null | undefined
) => can(SERVER_SETTINGS_PERMISSIONS) || (isInstanceOwner && !activeInstanceDomain);
