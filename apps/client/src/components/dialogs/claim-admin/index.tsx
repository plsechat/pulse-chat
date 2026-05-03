import { AutoFocus } from '@/components/ui/auto-focus';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { TDialogBaseProps } from '../types';

const ClaimAdminDialog = memo(({ isOpen, close }: TDialogBaseProps) => {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = useCallback(async () => {
    const trpc = getTRPCClient();

    setLoading(true);

    try {
      await trpc.others.useSecretToken.mutate({ token });
      toast.success('You are now an owner of this server');
      close();
    } catch (err) {
      toast.error(getTrpcError(err, 'Invalid access token'));
    } finally {
      setLoading(false);
    }
  }, [token, close]);

  return (
    <Dialog open={isOpen}>
      <DialogContent onInteractOutside={close} close={close}>
        <DialogHeader>
          <DialogTitle>Claim Admin</DialogTitle>
        </DialogHeader>

        <Group label="Access token">
          <AutoFocus>
            <Input
              type="password"
              placeholder="Enter access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              name="token"
              onEnter={onSubmit}
            />
          </AutoFocus>
        </Group>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={loading || !token}>
            Claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export { ClaimAdminDialog };
