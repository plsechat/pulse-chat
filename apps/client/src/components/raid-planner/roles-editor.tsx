import { Button } from '@/components/ui/button';
import Color from '@/components/ui/color';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import {
  keyFromLabel,
  MAX_ROLES,
  newRoleDraft,
  ROLE_PALETTE,
  type TRoleDraft,
  type TRoleDraftErrors
} from '@/features/events/role-drafts';
import { Plus, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';

type TRolesEditorProps = {
  value: TRoleDraft[];
  onChange: (next: TRoleDraft[]) => void;
  errors?: TRoleDraftErrors[];
  disabled?: boolean;
};

/** Rows of colour · label · key · cap, used by the event editor and the templates screen. */
const RolesEditor = memo(
  ({ value, onChange, errors, disabled }: TRolesEditorProps) => {
    const update = useCallback(
      (index: number, patch: Partial<TRoleDraft>) => {
        onChange(
          value.map((row, i) => (i === index ? { ...row, ...patch } : row))
        );
      },
      [value, onChange]
    );

    return (
      <div className="flex flex-col gap-2">
        {value.map((row, index) => {
          const rowErrors = errors?.[index] ?? {};
          return (
            <div
              key={index}
              className="flex flex-wrap items-start gap-2 rounded-lg border border-border/60 p-2"
            >
              <Color
                value={row.color}
                onChange={(color) => update(index, { color })}
                error={rowErrors.color}
                defaultValue={ROLE_PALETTE[index % ROLE_PALETTE.length]}
              />
              <div className="min-w-[8rem] flex-1">
                <Input
                  aria-label={`Role ${index + 1} label`}
                  placeholder="Label (Tank)"
                  value={row.label}
                  maxLength={40}
                  disabled={disabled}
                  error={rowErrors.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    // The key follows the label until it is typed by hand.
                    const keyFollows =
                      row.key === '' || row.key === keyFromLabel(row.label);
                    update(index, {
                      label,
                      ...(keyFollows ? { key: keyFromLabel(label) } : {})
                    });
                  }}
                />
              </div>
              <div className="w-28">
                <Input
                  aria-label={`Role ${index + 1} key`}
                  placeholder="key"
                  value={row.key}
                  maxLength={24}
                  disabled={disabled}
                  error={rowErrors.key}
                  onChange={(e) => update(index, { key: e.target.value })}
                />
              </div>
              <div className="w-20">
                <Input
                  aria-label={`Role ${index + 1} cap`}
                  placeholder="∞"
                  title="Cap (empty = unlimited)"
                  inputMode="numeric"
                  value={row.cap}
                  disabled={disabled}
                  error={rowErrors.cap}
                  onChange={(e) =>
                    update(index, {
                      cap: e.target.value.replace(/[^0-9]/g, '')
                    })
                  }
                />
              </div>
              <IconButton
                variant="destructive"
                size="sm"
                icon={Trash2}
                aria-label={`Remove role ${row.label || index + 1}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="mt-2.5"
              />
            </div>
          );
        })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || value.length >= MAX_ROLES}
          onClick={() => onChange([...value, newRoleDraft(value.length)])}
          className="self-start"
        >
          <Plus className="h-4 w-4" />
          Add role
        </Button>
      </div>
    );
  }
);

export { RolesEditor };
