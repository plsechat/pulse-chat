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
import { Switch } from '@/components/ui/switch';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { Plus, X } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { TDialogBaseProps } from '../types';

/** Mirrors polls.create: question ≤ 200, 2–10 options ≤ 80 each. */
const MAX_QUESTION = 200;
const MAX_OPTION = 80;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

/** "Closes in" choices, in minutes; 0 = no deadline. */
const CLOSE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'No deadline' },
  { value: 60, label: '1 hour' },
  { value: 4 * 60, label: '4 hours' },
  { value: 24 * 60, label: '1 day' },
  { value: 3 * 24 * 60, label: '3 days' },
  { value: 7 * 24 * 60, label: '1 week' }
];

export type TCreatePollDialogProps = TDialogBaseProps & {
  channelId: number;
};

const CreatePollDialog = memo(({ isOpen, close, channelId }: TCreatePollDialogProps) => {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closesIn, setClosesIn] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const canSubmit =
    question.trim().length > 0 && filled.length >= MIN_OPTIONS && !saving;

  const setOption = useCallback((index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  }, []);

  const removeOption = useCallback((index: number) => {
    setOptions((prev) => (prev.length > MIN_OPTIONS ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const addOption = useCallback(() => {
    setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ''] : prev));
  }, []);

  const onSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const trpc = getTRPCClient();
    if (!trpc) return;

    setSaving(true);
    setError(null);
    try {
      await trpc.polls.create.mutate({
        channelId,
        question: question.trim(),
        options: filled,
        multiple,
        anonymous,
        closesAt: closesIn > 0 ? Date.now() + closesIn * 60_000 : undefined
      });
      close();
    } catch (err) {
      setError(getTrpcError(err, 'Could not create the poll'));
      toast.error(getTrpcError(err, 'Could not create the poll'));
    } finally {
      setSaving(false);
    }
  }, [canSubmit, channelId, question, filled, multiple, anonymous, closesIn, close]);

  return (
    <Dialog open={isOpen}>
      <DialogContent onInteractOutside={close} close={close} className="max-h-[calc(var(--vvh)*0.9)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create poll</DialogTitle>
          <DialogDescription>
            Everyone who can read the channel can vote; results update live.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
        >
          <Group label="Question" required>
            <AutoFocus>
              <Input
                placeholder="What should we do?"
                value={question}
                maxLength={MAX_QUESTION}
                onChange={(e) => setQuestion(e.target.value)}
                aria-label="Poll question"
              />
            </AutoFocus>
          </Group>

          <Group label="Options" description={`Between ${MIN_OPTIONS} and ${MAX_OPTIONS}.`}>
            <ol className="flex flex-col gap-2" aria-label="Poll options">
              {options.map((option, index) => (
                <li key={index} className="flex items-center gap-2">
                  <Input
                    placeholder={`Option ${index + 1}`}
                    value={option}
                    maxLength={MAX_OPTION}
                    onChange={(e) => setOption(index, e.target.value)}
                    aria-label={`Option ${index + 1}`}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => removeOption(index)}
                    disabled={options.length <= MIN_OPTIONS}
                    aria-label={`Remove option ${index + 1}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ol>
            {options.length < MAX_OPTIONS && (
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={addOption}>
                <Plus className="h-4 w-4" />
                Add option
              </Button>
            )}
          </Group>

          <div className="grid gap-4 sm:grid-cols-2">
            <Group label="Multiple choice" description="Voters may pick more than one option.">
              <Switch checked={multiple} onCheckedChange={setMultiple} aria-label="Multiple choice" />
            </Group>
            <Group label="Anonymous" description="Nobody sees who voted for what.">
              <Switch checked={anonymous} onCheckedChange={setAnonymous} aria-label="Anonymous votes" />
            </Group>
          </div>

          <Group label="Closes in">
            <Select value={String(closesIn)} onValueChange={(v) => setClosesIn(Number(v))}>
              <SelectTrigger className="w-48" aria-label="Closes in">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLOSE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Group>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? 'Creating…' : 'Create poll'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
});

export { CreatePollDialog };
