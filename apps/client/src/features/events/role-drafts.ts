import type { TEventRole } from '@pulse/server/types';

/**
 * The roster shape as the user edits it. Caps are text so an emptied
 * field means "unlimited" instead of snapping back to a number; the
 * bounds below are the server's (eventRoleSchema) so a rejected row is
 * flagged before the round trip.
 */
export type TRoleDraft = {
  key: string;
  label: string;
  cap: string;
  color: string;
};

export const ROLE_PALETTE = [
  '#60a5fa',
  '#5ee29a',
  '#ff5c6c',
  '#ffb454',
  '#c89bff',
  '#2fe3c2',
  '#f27ab8',
  '#8fd6ff'
] as const;

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const MAX_ROLES = 12;

export const roleToDraft = (role: TEventRole): TRoleDraft => ({
  key: role.key,
  label: role.label,
  cap: role.cap === null ? '' : String(role.cap),
  color: role.color ?? ROLE_PALETTE[0]
});

export const newRoleDraft = (index: number): TRoleDraft => ({
  key: '',
  label: '',
  cap: '',
  color: ROLE_PALETTE[index % ROLE_PALETTE.length]!
});

/** A key from a label: "Main tank" → "main-tank". */
export const keyFromLabel = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

export type TRoleDraftErrors = Partial<Record<keyof TRoleDraft, string>>;

/** Per-row problems, in the server's words; no messages = a valid roster. */
export const validateRoleDrafts = (
  drafts: TRoleDraft[]
): { rows: TRoleDraftErrors[]; general?: string; ok: boolean } => {
  const rows = drafts.map((draft): TRoleDraftErrors => {
    const errors: TRoleDraftErrors = {};
    const key = draft.key.trim();
    if (!key) errors.key = 'Required';
    else if (key.length > 24) errors.key = 'At most 24 characters';
    else if (!KEY_PATTERN.test(key)) errors.key = 'Letters, digits, - and _';
    const label = draft.label.trim();
    if (!label) errors.label = 'Required';
    else if (label.length > 40) errors.label = 'At most 40 characters';
    if (draft.cap.trim() !== '') {
      const cap = Number(draft.cap);
      if (!Number.isInteger(cap) || cap < 1 || cap > 200) {
        errors.cap = '1–200, or empty for unlimited';
      }
    }
    if (!HEX_PATTERN.test(draft.color)) errors.color = 'Colours are #rrggbb';
    return errors;
  });
  const keys = drafts.map((d) => d.key.trim());
  for (let i = 0; i < drafts.length; i++) {
    const key = keys[i]!;
    if (key && keys.indexOf(key) !== i && !rows[i]!.key) {
      rows[i]!.key = 'Keys must be unique';
    }
  }
  let general: string | undefined;
  if (drafts.length === 0) general = 'Add at least one role';
  else if (drafts.length > MAX_ROLES) general = `At most ${MAX_ROLES} roles`;
  const ok = !general && rows.every((row) => Object.keys(row).length === 0);
  return { rows, general, ok };
};

export const draftsToRoles = (drafts: TRoleDraft[]): TEventRole[] =>
  drafts.map((draft) => ({
    key: draft.key.trim(),
    label: draft.label.trim(),
    cap: draft.cap.trim() === '' ? null : Number(draft.cap),
    color: draft.color
  }));
