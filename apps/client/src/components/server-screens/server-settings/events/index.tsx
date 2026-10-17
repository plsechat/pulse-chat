import { RolePill } from '@/components/raid-planner/bits';
import { RolesEditor } from '@/components/raid-planner/roles-editor';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { requestConfirmation } from '@/features/dialogs/actions';
import {
  createRosterTemplate,
  deleteRosterTemplate,
  fetchRosterTemplates,
  updateRosterTemplate
} from '@/features/events/actions';
import { useRosterTemplates } from '@/features/events/hooks';
import {
  draftsToRoles,
  newRoleDraft,
  roleToDraft,
  validateRoleDrafts,
  type TRoleDraft,
  type TRoleDraftErrors
} from '@/features/events/role-drafts';
import { useConnectedServerPublicId } from '@/features/server/hooks';
import { getTrpcError, parseTrpcErrors } from '@/helpers/parse-trpc-errors';
import type { TEventRosterTemplate } from '@pulse/server/types';
import { LayoutTemplate, Pencil, Plus, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const NAME_MAX = 60;

type TTemplateFormProps = {
  template?: TEventRosterTemplate;
  onDone: () => void;
};

/** Name + roles, for a new template or an existing one. */
const TemplateForm = memo(({ template, onDone }: TTemplateFormProps) => {
  const [name, setName] = useState(template?.name ?? '');
  const [roles, setRoles] = useState<TRoleDraft[]>(() =>
    template ? template.roles.map(roleToDraft) : [newRoleDraft(0)]
  );
  const [nameError, setNameError] = useState<string | undefined>();
  const [roleErrors, setRoleErrors] = useState<TRoleDraftErrors[]>([]);
  const [general, setGeneral] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    const trimmed = name.trim();
    const nameProblem = !trimmed
      ? 'Give the template a name'
      : trimmed.length > NAME_MAX
        ? `At most ${NAME_MAX} characters`
        : undefined;
    const result = validateRoleDrafts(roles);
    setNameError(nameProblem);
    setRoleErrors(result.rows);
    setGeneral(result.general);
    if (nameProblem || !result.ok) return;

    setSaving(true);
    try {
      if (template) {
        await updateRosterTemplate(template.id, {
          name: trimmed,
          roles: draftsToRoles(roles)
        });
        toast.success('Template saved');
      } else {
        await createRosterTemplate(trimmed, draftsToRoles(roles));
        toast.success('Template created');
      }
      onDone();
    } catch (err) {
      const parsed = parseTrpcErrors(err);
      if (parsed.name) setNameError(parsed.name);
      else setGeneral(parsed._general ?? parsed.roles ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <Group label="Name" required>
        <Input
          placeholder="e.g. 10-man, PvP squad"
          value={name}
          maxLength={NAME_MAX}
          error={nameError}
          onChange={(e) => {
            setName(e.target.value);
            setNameError(undefined);
          }}
          onEnter={onSave}
        />
      </Group>
      <Group
        label="Roles"
        description="Each role has a label, a short key and an optional cap. Members pick one when they sign up."
      >
        <RolesEditor
          value={roles}
          onChange={(next) => {
            setRoles(next);
            setGeneral(undefined);
          }}
          errors={roleErrors}
          disabled={saving}
        />
        {general && (
          <p className="text-sm text-destructive" role="alert">
            {general}
          </p>
        )}
      </Group>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDone}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : template ? 'Save template' : 'Create template'}
        </Button>
      </div>
    </div>
  );
});

const TemplateRow = memo(({ template }: { template: TEventRosterTemplate }) => {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onDelete = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: 'Delete template',
      message: `Delete "${template.name}"? Events already created from it keep their roster.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep it',
      variant: 'danger'
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteRosterTemplate(template.id);
      toast.success('Template deleted');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to delete the template'));
    } finally {
      setDeleting(false);
    }
  }, [template.id, template.name]);

  if (editing) {
    return (
      <TemplateForm template={template} onDone={() => setEditing(false)} />
    );
  }

  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">
          {template.name}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {template.roles.map((role) => (
            <RolePill
              key={role.key}
              role={role}
              hint={role.cap === null ? 'unlimited' : `cap ${role.cap}`}
            />
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setEditing(true)}
          title={`Edit ${template.name}`}
          disabled={deleting}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={onDelete}
          title={`Delete ${template.name}`}
          disabled={deleting}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});

/** Server Settings → Events: the roster templates events are created from. */
const Events = memo(() => {
  const templates = useRosterTemplates();
  const serverKey = useConnectedServerPublicId();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (serverKey) void fetchRosterTemplates();
  }, [serverKey]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Roster templates</h3>
          <p className="text-sm text-muted-foreground">
            Reusable role line-ups for new events. An event snapshots its
            template when it is created, so edits here only shape future events.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
          <Plus className="mr-1 h-4 w-4" />
          New template
        </Button>
      </div>

      {creating && <TemplateForm onDone={() => setCreating(false)} />}

      {templates === null ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          Loading templates…
        </div>
      ) : templates.length === 0 && !creating ? (
        <EmptyState
          icon={LayoutTemplate}
          title="No templates yet"
          description="Create one so hosts can set up a roster in a click."
          size="sm"
        />
      ) : (
        <div className="space-y-2">
          {templates.map((template) => (
            <TemplateRow key={template.id} template={template} />
          ))}
        </div>
      )}
    </div>
  );
});

export { Events };
