import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import { useState } from 'react';
import { toast } from 'sonner';

const REASONS = [
  { value: 'illegal', label: 'Illegal content' },
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'other', label: 'Something else' }
] as const;

type TReportReason = (typeof REASONS)[number]['value'];

/**
 * Reports go to the INSTANCE operator (not server moderators) and are
 * the participant-granted path by which they may see content: the
 * report carries this one item, nothing around it. For E2EE targets
 * the decrypted text shown on screen travels with the report — the
 * server only holds ciphertext.
 */
const ReportDialog = ({
  open,
  onOpenChange,
  kind,
  targetId,
  content,
  homeScope = false
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: 'message' | 'dm_message' | 'user';
  targetId: number;
  /** The content as rendered (decrypted) — snapshot evidence. */
  content?: string | null;
  /** Set when `targetId` is a HOME id even though a federated instance is active. */
  homeScope?: boolean;
}) => {
  const [reason, setReason] = useState<TReportReason>('spam');
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    // DM ids live in the HOME id space and DMs are always home-hosted,
    // so their reports must never follow activeInstanceDomain; channel
    // messages and users belong to their caller's id space (ambient, or
    // home when the caller says so) and the report goes to the operator
    // of the instance that owns that id space.
    const trpc =
      kind === 'dm_message' || homeScope
        ? getHomeTRPCClient()
        : getTRPCClient();
    if (!trpc) return;
    setSubmitting(true);
    try {
      await trpc.reports.create.mutate({
        kind,
        targetId,
        reason,
        details: details.trim() || undefined,
        decryptedContent: content ?? undefined
      });
      toast.success('Report sent to the instance operator');
      onOpenChange(false);
      setDetails('');
    } catch (error) {
      toast.error(getTrpcError(error, 'Could not send the report'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {kind === 'user' ? 'Report user' : 'Report message'}
          </DialogTitle>
          <DialogDescription>
            {kind === 'message'
              ? "Sent to this server's moderators with a copy of this message; the instance operator also receives it — nothing else from the conversation is shared."
              : kind === 'dm_message'
                ? "Sent to the instance operator with a copy of this message — nothing else from the conversation is shared."
                : 'Sent to the instance operator with the account details — none of your conversations are shared.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select
            value={reason}
            onValueChange={(v) => setReason(v as TReportReason)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Anything the operator should know (optional)"
            maxLength={1000}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            Send report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export { ReportDialog };
