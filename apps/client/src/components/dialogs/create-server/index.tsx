import { AutoFocus } from '@/components/ui/auto-focus';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import {
  createServer,
  joinServerByInvite,
  switchServer
} from '@/features/app/actions';
import { getHandshakeHash } from '@/features/server/actions';
import { useForm } from '@/hooks/use-form';
import { memo, useCallback, useState } from 'react';
import type { TDialogBaseProps } from '../types';

function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/invite=([^&#\s]+)/);
  return match ? match[1] : trimmed;
}

type TCreateServerDialogProps = TDialogBaseProps;

const CreateServerDialog = memo(
  ({ isOpen, close }: TCreateServerDialogProps) => {
    const {
      values: createValues,
      r: createR,
      setTrpcErrors: setCreateErrors
    } = useForm({ name: '' });
    const {
      values: joinValues,
      r: joinR,
      setTrpcErrors: setJoinErrors
    } = useForm({ inviteCode: '' });
    const [createLoading, setCreateLoading] = useState(false);
    const [joinLoading, setJoinLoading] = useState(false);

    const onCreateSubmit = useCallback(async () => {
      if (!createValues.name.trim()) return;

      setCreateLoading(true);

      try {
        const server = await createServer(createValues.name.trim());

        if (server) {
          const hash = getHandshakeHash();
          if (hash) {
            await switchServer(server.id, hash);
          }
        }

        close();
      } catch (error) {
        setCreateErrors(error);
      } finally {
        setCreateLoading(false);
      }
    }, [createValues.name, close, setCreateErrors]);

    const onJoinSubmit = useCallback(async () => {
      if (!joinValues.inviteCode.trim()) return;

      setJoinLoading(true);

      try {
        const code = extractInviteCode(joinValues.inviteCode);
        const server = await joinServerByInvite(code);

        if (server) {
          const hash = getHandshakeHash();
          if (hash) {
            await switchServer(server.id, hash);
          }
        }

        close();
      } catch (error) {
        setJoinErrors(error);
      } finally {
        setJoinLoading(false);
      }
    }, [joinValues.inviteCode, close, setJoinErrors]);

    return (
      <Dialog open={isOpen}>
        <DialogContent onInteractOutside={close} close={close}>
          <DialogHeader>
            <DialogTitle>Create a Server</DialogTitle>
            <DialogDescription>
              Give your new server a name to get started.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Group label="Server name">
              <AutoFocus>
                <Input
                  {...createR('name')}
                  placeholder="My Server"
                  onEnter={onCreateSubmit}
                />
              </AutoFocus>
            </Group>
            <Button
              className="w-full"
              onClick={onCreateSubmit}
              disabled={createLoading || !createValues.name.trim()}
            >
              {createLoading ? 'Creating...' : 'Create Server'}
            </Button>
          </div>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                or join existing
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Have an invite? Enter the code or link below.
            </p>
            <Group label="Invite code or link">
              <Input
                {...joinR('inviteCode')}
                placeholder="abc123 or https://chat.com/invite=abc123"
                onEnter={onJoinSubmit}
              />
            </Group>
            <Button
              className="w-full"
              variant="outline"
              onClick={onJoinSubmit}
              disabled={joinLoading || !joinValues.inviteCode.trim()}
            >
              {joinLoading ? 'Joining...' : 'Join Server'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

export { CreateServerDialog };
