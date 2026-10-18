import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { TImportOptionsInput } from '@/features/server/import/hooks';
import { cn } from '@/lib/utils';
import type { TImportPreview } from '@pulse/server/types';
import { Loader2 } from 'lucide-react';
import { memo } from 'react';
import { formatCount } from './format';

type TOptionsStepProps = {
  options: TImportOptionsInput;
  preview: TImportPreview | null;
  busy: string | null;
  onChange: (next: TImportOptionsInput) => void;
  onBack: () => void;
  onStart: () => Promise<void>;
};

type TChoice<K extends keyof TImportOptionsInput> = {
  value: TImportOptionsInput[K];
  label: string;
  hint: string;
};

const ChoiceGroup = <K extends keyof TImportOptionsInput>({
  name,
  title,
  description,
  choices,
  value,
  onSelect
}: {
  name: K;
  title: string;
  description: string;
  choices: TChoice<K>[];
  value: TImportOptionsInput[K];
  onSelect: (value: TImportOptionsInput[K]) => void;
}) => (
  <fieldset className="space-y-2">
    <legend className="text-sm font-medium">{title}</legend>
    <p className="text-xs text-muted-foreground">{description}</p>
    <div className="grid gap-2 sm:grid-cols-2">
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <label
            key={String(choice.value)}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
              checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50'
            )}
          >
            <input
              type="radio"
              name={`import-${name}`}
              className="mt-1"
              checked={checked}
              onChange={() => onSelect(choice.value)}
            />
            <span>
              <span className="block text-sm font-medium">{choice.label}</span>
              <span className="block text-xs text-muted-foreground">{choice.hint}</span>
            </span>
          </label>
        );
      })}
    </div>
  </fieldset>
);

/** Step 4. Four decisions, each with the consequence written next to it. */
const OptionsStep = memo(({ options, preview, busy, onChange, onBack, onStart }: TOptionsStepProps) => {
  const estimate = (depth: TImportOptionsInput['history']) =>
    preview ? `~${formatCount(preview.estimateByDepth[depth])} messages` : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Options</CardTitle>
        <CardDescription>Decide how much comes over. You can't change these once the import runs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ChoiceGroup
          name="history"
          title="Message history"
          description="Older messages take longer; attachments make it longer still."
          value={options.history}
          onSelect={(history) => onChange({ ...options, history })}
          choices={[
            { value: 'all', label: 'Everything', hint: estimate('all') || 'Every message in every channel' },
            { value: 'last30days', label: 'Last 30 days', hint: estimate('last30days') || 'Recent conversations only' },
            { value: 'last1000', label: 'Last 1,000 per channel', hint: estimate('last1000') || 'A good snapshot of each channel' },
            { value: 'none', label: 'No history', hint: 'Channels, roles, emoji and members only' }
          ]}
        />

        <ChoiceGroup
          name="attachments"
          title="Attachments"
          description="Files are copied during the run because their links on the other side expire."
          value={options.attachments}
          onSelect={(attachments) => onChange({ ...options, attachments })}
          choices={[
            { value: 'download', label: 'Copy the files', hint: 'Within this server\'s upload limits; too-large files are noted in the message' },
            { value: 'skip', label: 'Skip files', hint: 'Messages keep a note with the file name' }
          ]}
        />

        <ChoiceGroup
          name="members"
          title="Members"
          description="Members become placeholders that keep their name and avatar. When one of them signs in here with the same account, their messages become theirs."
          value={options.members}
          onSelect={(members) => onChange({ ...options, members })}
          choices={[
            { value: 'posters', label: 'Everyone who posted', hint: 'A placeholder for each author in the history' },
            { value: 'everyone', label: 'Everyone in the community', hint: 'Every member, with their roles, posted or not' },
            { value: 'nobody', label: 'Nobody', hint: 'All history is shown as "Imported history"' }
          ]}
        />

        <ChoiceGroup
          name="roles"
          title="Roles"
          description="Names, colours and order come over; permissions are matched as closely as ours allow."
          value={options.roles}
          onSelect={(roles) => onChange({ ...options, roles })}
          choices={[
            { value: 'import', label: 'Bring the roles', hint: 'Members keep the roles they had' },
            { value: 'skip', label: 'Skip roles', hint: 'Everyone arrives with the default role' }
          ]}
        />

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onBack} disabled={busy !== null}>
            Back
          </Button>
          <Button onClick={onStart} disabled={busy !== null}>
            {busy === 'start' && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Start the import
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});

export { OptionsStep };
