import { DatePicker } from '@/components/date-picker';
import { AutoFocus } from '@/components/ui/auto-focus';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  closeEventEditor,
  createEvent,
  updateEvent,
  type TEventInput
} from '@/features/events/actions';
import {
  combineDayAndTime,
  dayStartOf,
  HOUR_MS,
  timeInputValue
} from '@/features/events/calendar';
import {
  useEventDetail,
  useEventEditor,
  useRosterTemplates,
  useViewableTextChannels
} from '@/features/events/hooks';
import {
  draftsToRoles,
  newRoleDraft,
  roleToDraft,
  validateRoleDrafts,
  type TRoleDraft,
  type TRoleDraftErrors
} from '@/features/events/role-drafts';
import { parseTrpcErrors, type TTrpcErrors } from '@/helpers/parse-trpc-errors';
import type { TEvent, TEventRosterTemplate } from '@pulse/server/types';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RolePill } from './bits';
import { RolesEditor } from './roles-editor';

const DURATION_PRESETS = [30, 60, 90, 120, 180, 240, 360] as const;
const MAX_DURATION_MIN = 24 * 60;
/** Server grace for "starts in the past" (PAST_START_GRACE_MS is 5 min); stay inside it. */
const PAST_GRACE_MS = 4 * 60 * 1000;
const CUSTOM = 'custom';
const NONE = 'none';

const durationLabel = (minutes: number) => {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
};

type TFormState = {
  title: string;
  description: string;
  gameTag: string;
  day: number;
  time: string;
  durationMin: number;
  templateId: string;
  roles: TRoleDraft[];
  maxParticipants: string;
  announceChannelId: string;
};

const initialForm = (
  mode: 'create' | 'edit',
  event: TEvent | undefined,
  startsAt: number | undefined,
  templates: TEventRosterTemplate[] | null
): TFormState => {
  if (mode === 'edit' && event) {
    return {
      title: event.title,
      description: event.description ?? '',
      gameTag: event.gameTag ?? '',
      day: dayStartOf(event.startsAt),
      time: timeInputValue(event.startsAt),
      durationMin: Math.round((event.endsAt - event.startsAt) / 60_000),
      templateId: event.templateId === null ? CUSTOM : String(event.templateId),
      roles: event.roles.map(roleToDraft),
      maxParticipants:
        event.maxParticipants === null ? '' : String(event.maxParticipants),
      announceChannelId:
        event.announceChannelId === null
          ? NONE
          : String(event.announceChannelId)
    };
  }
  const start = startsAt ?? Date.now() + HOUR_MS;
  const first = templates?.[0];
  return {
    title: '',
    description: '',
    gameTag: '',
    day: dayStartOf(start),
    time: timeInputValue(start),
    durationMin: 120,
    templateId: first ? String(first.id) : CUSTOM,
    roles: first ? first.roles.map(roleToDraft) : [newRoleDraft(0)],
    maxParticipants: '',
    announceChannelId: NONE
  };
};

type TValidation = {
  fields: TTrpcErrors;
  roles: TRoleDraftErrors[];
  ok: boolean;
};

/** Same bounds as the server's eventFieldsSchema and validateWindow. */
const validate = (
  form: TFormState,
  mode: 'create' | 'edit',
  now: number
): TValidation => {
  const fields: TTrpcErrors = {};
  const title = form.title.trim();
  if (!title) fields.title = 'Give the event a title';
  else if (title.length > 120) fields.title = 'At most 120 characters';
  if (form.description.length > 2000)
    fields.description = 'At most 2000 characters';
  if (form.gameTag.trim().length > 40) fields.gameTag = 'At most 40 characters';
  if (!form.day) fields.day = 'Pick a date';
  if (!/^\d{2}:\d{2}$/.test(form.time)) fields.time = 'Pick a time';
  const startsAt = form.day ? combineDayAndTime(form.day, form.time) : 0;
  if (mode === 'create' && startsAt && startsAt < now - PAST_GRACE_MS) {
    fields.time = 'The event cannot start in the past';
  }
  if (form.durationMin < 1 || form.durationMin > MAX_DURATION_MIN) {
    fields.durationMin = 'Between 1 minute and 24 hours';
  }
  if (form.maxParticipants.trim() !== '') {
    const n = Number(form.maxParticipants);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      fields.maxParticipants = '1–500, or empty for no cap';
    }
  }
  const roles =
    form.templateId === CUSTOM
      ? validateRoleDrafts(form.roles)
      : { rows: [], ok: true, general: undefined };
  if (roles.general) fields.roles = roles.general;
  return {
    fields,
    roles: roles.rows,
    ok: Object.keys(fields).length === 0 && roles.ok
  };
};

const toInput = (form: TFormState, includeRoster: boolean): TEventInput => {
  const startsAt = combineDayAndTime(form.day, form.time);
  const roster: Pick<TEventInput, 'templateId' | 'roles'> = !includeRoster
    ? {}
    : form.templateId === CUSTOM
      ? { roles: draftsToRoles(form.roles) }
      : { templateId: Number(form.templateId) };
  return {
    title: form.title.trim(),
    description: form.description.trim() || null,
    gameTag: form.gameTag.trim() || null,
    startsAt,
    endsAt: startsAt + form.durationMin * 60_000,
    maxParticipants:
      form.maxParticipants.trim() === '' ? null : Number(form.maxParticipants),
    announceChannelId:
      form.announceChannelId === NONE ? null : Number(form.announceChannelId),
    ...roster
  };
};

type TEditorFormProps = {
  mode: 'create' | 'edit';
  event: TEvent | undefined;
  startsAt: number | undefined;
};

const EditorForm = memo(({ mode, event, startsAt }: TEditorFormProps) => {
  const templates = useRosterTemplates();
  const channels = useViewableTextChannels();
  const [form, setForm] = useState<TFormState>(() =>
    initialForm(mode, event, startsAt, templates)
  );
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [roleErrors, setRoleErrors] = useState<TRoleDraftErrors[]>([]);
  // An edit only resends the roster when the host touched it: the
  // event holds a snapshot, and re-picking a template re-snapshots.
  const [rosterTouched, setRosterTouched] = useState(mode === 'create');
  const [saving, setSaving] = useState(false);

  const patch = useCallback(
    (changes: Partial<TFormState>) =>
      setForm((prev) => ({ ...prev, ...changes })),
    []
  );

  const durations = useMemo<number[]>(() => {
    const list: number[] = [...DURATION_PRESETS];
    if (!list.includes(form.durationMin)) {
      list.push(form.durationMin);
      list.sort((a, b) => a - b);
    }
    return list;
  }, [form.durationMin]);

  const onTemplateChange = (value: string) => {
    setRosterTouched(true);
    if (value === CUSTOM) {
      patch({ templateId: CUSTOM });
      return;
    }
    const template = templates?.find((t) => String(t.id) === value);
    if (!template) return;
    // The template's roles are shown as a read-only preview; editing
    // them switches to a custom roster (the server snapshots whichever
    // the event is created with).
    patch({ templateId: value, roles: template.roles.map(roleToDraft) });
  };

  const onRolesChange = (roles: TRoleDraft[]) => {
    setRosterTouched(true);
    patch({ roles, templateId: CUSTOM });
  };

  const onSubmit = async () => {
    const result = validate(form, mode, Date.now());
    setErrors(result.fields);
    setRoleErrors(result.roles);
    if (!result.ok) return;
    setSaving(true);
    try {
      if (mode === 'edit' && event) {
        await updateEvent(event.id, toInput(form, rosterTouched));
        toast.success('Event updated');
      } else {
        await createEvent(toInput(form, true));
        toast.success('Event created');
      }
      closeEventEditor();
    } catch (err) {
      const parsed = parseTrpcErrors(err);
      setErrors(parsed);
      if (parsed._general) toast.error(parsed._general);
    } finally {
      setSaving(false);
    }
  };

  const previewRoles = draftsToRoles(form.roles);
  const endsAt =
    combineDayAndTime(form.day, form.time) + form.durationMin * 60_000;
  const crossesMidnight = dayStartOf(endsAt) !== form.day;

  return (
    <>
      <div className="flex flex-col gap-4">
        <Group label="Title" required>
          <AutoFocus>
            <Input
              name="title"
              placeholder="Raid night"
              value={form.title}
              maxLength={120}
              error={errors.title}
              resetError={setErrors}
              onChange={(e) => patch({ title: e.target.value })}
              onEnter={onSubmit}
            />
          </AutoFocus>
        </Group>

        <div className="grid gap-4 sm:grid-cols-[1fr_7.5rem_9rem]">
          <Group label="Date" required>
            <DatePicker
              value={form.day}
              onChange={(ts) => patch({ day: ts ? dayStartOf(ts) : 0 })}
              minDate={mode === 'create' ? dayStartOf(Date.now()) : undefined}
            />
            {errors.day && (
              <p className="text-sm text-destructive" role="alert">
                {errors.day}
              </p>
            )}
          </Group>
          <Group label="Start" required>
            <Input
              name="time"
              type="time"
              value={form.time}
              error={errors.time ?? errors.startsAt}
              resetError={setErrors}
              onChange={(e) => patch({ time: e.target.value })}
            />
          </Group>
          <Group label="Duration" required>
            <Select
              value={String(form.durationMin)}
              onValueChange={(value) => patch({ durationMin: Number(value) })}
            >
              <SelectTrigger className="w-full" aria-label="Duration">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {durations.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {durationLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(errors.durationMin ?? errors.endsAt) && (
              <p className="text-sm text-destructive" role="alert">
                {errors.durationMin ?? errors.endsAt}
              </p>
            )}
            {crossesMidnight && !errors.durationMin && (
              <p className="text-xs text-muted-foreground">Ends the next day</p>
            )}
          </Group>
        </div>

        <Group label="Description">
          <Textarea
            name="description"
            placeholder="What are we doing, what to bring, where to meet…"
            value={form.description}
            maxLength={2000}
            error={errors.description}
            resetError={setErrors}
            onChange={(e) => patch({ description: e.target.value })}
            className="min-h-20"
          />
        </Group>

        <div className="grid gap-4 sm:grid-cols-2">
          <Group label="Game" description="Shown as a tag on the event.">
            <Input
              name="gameTag"
              placeholder="e.g. the raid, the map, the mode"
              value={form.gameTag}
              maxLength={40}
              error={errors.gameTag}
              resetError={setErrors}
              onChange={(e) => patch({ gameTag: e.target.value })}
            />
          </Group>
          <Group
            label="Max participants"
            description="Across all roles; empty = no cap."
          >
            <Input
              name="maxParticipants"
              inputMode="numeric"
              placeholder="No cap"
              value={form.maxParticipants}
              error={errors.maxParticipants}
              resetError={setErrors}
              onChange={(e) =>
                patch({
                  maxParticipants: e.target.value.replace(/[^0-9]/g, '')
                })
              }
            />
          </Group>
        </div>

        <Group
          label="Roster"
          description="Pick a template or shape the roles yourself. The roster is fixed to this event once created; template edits do not reach it."
        >
          <Select value={form.templateId} onValueChange={onTemplateChange}>
            <SelectTrigger className="w-full" aria-label="Roster template">
              <SelectValue placeholder="Roster template" />
            </SelectTrigger>
            <SelectContent>
              {templates?.map((template) => (
                <SelectItem key={template.id} value={String(template.id)}>
                  {template.name}
                  <span className="text-xs text-muted-foreground">
                    {template.roles
                      .map(
                        (r) => `${r.label}${r.cap === null ? '' : ` ×${r.cap}`}`
                      )
                      .join(' · ')}
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom roles</SelectItem>
            </SelectContent>
          </Select>
          {form.templateId !== CUSTOM ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {previewRoles.map((role) => (
                <RolePill
                  key={role.key}
                  role={role}
                  hint={role.cap === null ? 'unlimited' : `cap ${role.cap}`}
                />
              ))}
              <Button
                type="button"
                size="sm"
                variant="link"
                onClick={() => onTemplateChange(CUSTOM)}
              >
                Customise
              </Button>
            </div>
          ) : (
            <RolesEditor
              value={form.roles}
              onChange={onRolesChange}
              errors={roleErrors}
              disabled={saving}
            />
          )}
          {errors.roles && (
            <p className="text-sm text-destructive" role="alert">
              {errors.roles}
            </p>
          )}
        </Group>

        <Group
          label="Announce in"
          description="Posts an RSVP card members can sign up from."
        >
          <Select
            value={form.announceChannelId}
            onValueChange={(value) => patch({ announceChannelId: value })}
          >
            <SelectTrigger className="w-full" aria-label="Announce channel">
              <SelectValue placeholder="No announcement" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No announcement</SelectItem>
              {channels.map((channel) => (
                <SelectItem key={channel.id} value={String(channel.id)}>
                  #{channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.announceChannelId && (
            <p className="text-sm text-destructive" role="alert">
              {errors.announceChannelId}
            </p>
          )}
        </Group>
      </div>

      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={closeEventEditor}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="button" onClick={onSubmit} disabled={saving}>
          {saving
            ? 'Saving…'
            : mode === 'edit'
              ? 'Save changes'
              : 'Create event'}
        </Button>
      </DialogFooter>
    </>
  );
});

/** The create / edit dialog; mounted by the content wrapper beside the sheet host. */
const EventEditorHost = memo(() => {
  const editor = useEventEditor();
  const detail = useEventDetail(editor?.mode === 'edit' ? editor.eventId : -1);
  const templates = useRosterTemplates();

  if (!editor) return null;

  const mode = editor.mode;
  const event = mode === 'edit' ? detail?.event : undefined;
  // Both the templates and (for an edit) the event must be in hand
  // before the form takes its initial values.
  const ready =
    templates !== null && (mode === 'create' || event !== undefined);

  return (
    <Dialog open onOpenChange={(open) => !open && closeEventEditor()}>
      <DialogContent
        close={closeEventEditor}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === 'edit' ? 'Edit event' : 'New event'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'edit'
              ? 'Changes reach everyone signed up right away.'
              : 'Times are in your local time zone.'}
          </DialogDescription>
        </DialogHeader>
        {ready ? (
          <EditorForm
            key={mode === 'edit' ? `edit:${event?.id}` : 'create'}
            mode={mode}
            event={event}
            startsAt={mode === 'create' ? editor.startsAt : undefined}
          />
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
});

export { EventEditorHost };
