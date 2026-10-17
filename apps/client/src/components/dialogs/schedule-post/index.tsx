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
  defaultSendAt,
  fromLocalInputValue,
  toLocalInputValue,
  validateSendAt
} from '@/features/scheduled/validation';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { fullDateTime } from '@/helpers/time-format';
import { getTRPCClient } from '@/lib/trpc';
import { format } from 'date-fns';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { TDialogBaseProps } from '../types';

export type TSchedulePostDialogProps = TDialogBaseProps & {
  channelId: number;
  /** The composer's content, already in the wire token format. */
  content: string;
  /** Staged upload ids the post should carry. */
  fileIds: string[];
  /** Runs after the row is created so the composer can clear itself. */
  onScheduled?: () => void;
};

/**
 * "Schedule" from the composer's "+" menu: the current draft, a date
 * and a time, sent by the server as the author when the time comes.
 * The window (2 min – 30 days) is checked here first so the message
 * sits by the field; the server checks it again.
 */
const SchedulePostDialog = memo(
  ({ isOpen, close, channelId, content, fileIds, onScheduled }: TSchedulePostDialogProps) => {
    const [value, setValue] = useState(() => toLocalInputValue(defaultSendAt(Date.now())));
    const [touched, setTouched] = useState(false);
    const [saving, setSaving] = useState(false);

    const sendAt = useMemo(() => fromLocalInputValue(value), [value]);
    const validation = validateSendAt(sendAt, Date.now());
    const empty = content.trim().length === 0 && fileIds.length === 0;

    const onSubmit = useCallback(async () => {
      setTouched(true);
      if (validation || sendAt === null || empty) return;
      const trpc = getTRPCClient();
      if (!trpc) return;

      setSaving(true);
      try {
        await trpc.scheduled.create.mutate({
          channelId,
          content,
          sendAt,
          files: fileIds.length > 0 ? fileIds : undefined
        });
        toast.success(`Scheduled for ${format(new Date(sendAt), fullDateTime())}`);
        onScheduled?.();
        close();
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not schedule the message'));
      } finally {
        setSaving(false);
      }
    }, [validation, sendAt, empty, channelId, content, fileIds, onScheduled, close]);

    return (
      <Dialog open={isOpen}>
        <DialogContent onInteractOutside={close} close={close}>
          <DialogHeader>
            <DialogTitle>Schedule message</DialogTitle>
            <DialogDescription>
              {empty
                ? 'Write the message first, then schedule it.'
                : 'The message is sent in your name at the chosen time. You can cancel it from the Scheduled list until then.'}
            </DialogDescription>
          </DialogHeader>

          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit();
            }}
          >
            <Group label="Send at" description="Between 2 minutes and 30 days from now, in your local time.">
              <Input
                type="datetime-local"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setTouched(true);
                }}
                aria-label="Send at"
                aria-invalid={touched && validation !== null}
                aria-describedby="schedule-send-at-error"
                className="w-full sm:w-64"
              />
              <p id="schedule-send-at-error" className="min-h-5 text-sm text-destructive" role="alert">
                {touched && validation ? validation : ''}
              </p>
            </Group>

            {fileIds.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {fileIds.length} attachment{fileIds.length === 1 ? '' : 's'} will be sent with it.
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || empty || (touched && validation !== null)}>
                {saving ? 'Scheduling…' : 'Schedule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }
);

export { SchedulePostDialog };
