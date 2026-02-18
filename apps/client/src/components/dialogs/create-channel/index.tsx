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
import { useActiveServerId } from '@/features/app/hooks';
import { parseTrpcErrors, type TTrpcErrors } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { ChannelType } from '@pulse/shared';
import { Hash, Mic } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import type { TDialogBaseProps } from '../types';

type TChannelTypeItemProps = {
  icon: React.ReactNode;
  title: string;
  description: string;
  isActive: boolean;
  onClick: () => void;
};

const ChannelTypeItem = ({
  icon,
  title,
  description,
  isActive,
  onClick
}: TChannelTypeItemProps) => (
  <div
    className={cn(
      'flex items-center gap-3 p-3 rounded-lg cursor-pointer border transition-colors',
      isActive
        ? 'border-primary bg-primary/10'
        : 'border-transparent hover:bg-muted/50'
    )}
    onClick={onClick}
  >
    <div
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
        isActive
          ? 'bg-primary/20 text-primary'
          : 'bg-muted text-muted-foreground'
      )}
    >
      {icon}
    </div>
    <div className="flex flex-col">
      <span className="font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{description}</span>
    </div>
  </div>
);

type TCreateChannelDialogProps = TDialogBaseProps & {
  categoryId: number;
  defaultChannelType?: ChannelType;
};

const CreateChannelDialog = memo(
  ({
    isOpen,
    categoryId,
    close,
    defaultChannelType = ChannelType.TEXT
  }: TCreateChannelDialogProps) => {
    const activeServerId = useActiveServerId();
    const [channelType, setChannelType] = useState(defaultChannelType);
    const [name, setName] = useState('New Channel');
    const [loading, setLoading] = useState(false);
    const [errors, setErrors] = useState<TTrpcErrors>({});

    const onSubmit = useCallback(async () => {
      if (!activeServerId) return;
      const trpc = getTRPCClient();

      setLoading(true);

      try {
        await trpc.channels.add.mutate({
          type: channelType,
          name,
          categoryId,
          serverId: activeServerId
        });

        close();
      } catch (error) {
        setErrors(parseTrpcErrors(error));
      } finally {
        setLoading(false);
      }
    }, [name, categoryId, close, channelType, activeServerId]);

    return (
      <Dialog open={isOpen}>
        <DialogContent onInteractOutside={close} close={close}>
          <DialogHeader>
            <DialogTitle>Create New Channel</DialogTitle>
          </DialogHeader>

          <Group label="Channel type">
            <ChannelTypeItem
              title="Text Channel"
              description="Share text, images, files and more"
              icon={<Hash className="h-6 w-6" />}
              isActive={channelType === ChannelType.TEXT}
              onClick={() => setChannelType(ChannelType.TEXT)}
            />

            <ChannelTypeItem
              title="Voice Channel"
              description="Hangout with voice, video and screen sharing"
              icon={<Mic className="h-6 w-6" />}
              isActive={channelType === ChannelType.VOICE}
              onClick={() => setChannelType(ChannelType.VOICE)}
            />
          </Group>

          <Group label="Channel name">
            <AutoFocus>
              <Input
                placeholder="Channel name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                name="name"
                error={errors.name}
                resetError={setErrors}
                onEnter={onSubmit}
              />
            </AutoFocus>
          </Group>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={onSubmit}
              disabled={loading || !name || !channelType}
            >
              Create channel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export { CreateChannelDialog };
