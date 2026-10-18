import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import { groupAvatarFallbackClass } from '@/components/user-avatar/fallback';
import { fetchDmChannels } from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { uploadFile } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Trash2, Upload } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { TDialogBaseProps } from './types';

export type TGroupDmSettingsDialogProps = TDialogBaseProps & {
  dmChannelId: number;
};

/**
 * Owner-only group DM settings: the display name and the group icon.
 * The icon goes through the temporary-upload flow (same as avatars);
 * `dms.updateGroup` saves it server-side and fans DM_CHANNEL_UPDATE out
 * to every member, whose client refetches the channel list.
 */
const GroupDmSettingsDialog = memo(
  ({ isOpen, close, dmChannelId }: TGroupDmSettingsDialogProps) => {
    const channels = useDmChannels();
    const channel = useMemo(
      () => channels.find((c) => c.id === dmChannelId),
      [channels, dmChannelId]
    );
    const openFilePicker = useFilePicker();
    const [name, setName] = useState(channel?.name ?? '');
    const [saving, setSaving] = useState(false);
    const [iconBusy, setIconBusy] = useState(false);

    const fallbackName = useMemo(
      () => channel?.members.map((m) => m.name).join(', ') || 'Group DM',
      [channel]
    );

    const saveName = useCallback(async () => {
      const trpc = getHomeTRPCClient();
      if (!trpc) return;
      setSaving(true);
      try {
        await trpc.dms.updateGroup.mutate({ dmChannelId, name: name.trim() });
        await fetchDmChannels();
        toast.success('Group updated');
        close();
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not update the group'));
      } finally {
        setSaving(false);
      }
    }, [dmChannelId, name, close]);

    const changeIcon = useCallback(async () => {
      const trpc = getHomeTRPCClient();
      if (!trpc) return;

      let file: File;
      try {
        [file] = await openFilePicker('image/*');
      } catch {
        return; // picker dismissed
      }

      setIconBusy(true);
      try {
        const temporaryFile = await uploadFile(file);
        if (!temporaryFile) {
          toast.error('Could not upload the image. Please try again.');
          return;
        }
        await trpc.dms.updateGroup.mutate({
          dmChannelId,
          iconTempFileId: temporaryFile.id
        });
        await fetchDmChannels();
        toast.success('Group icon updated');
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not update the group icon'));
      } finally {
        setIconBusy(false);
      }
    }, [dmChannelId, openFilePicker]);

    const removeIcon = useCallback(async () => {
      const trpc = getHomeTRPCClient();
      if (!trpc) return;
      setIconBusy(true);
      try {
        await trpc.dms.updateGroup.mutate({ dmChannelId, iconTempFileId: null });
        await fetchDmChannels();
        toast.success('Group icon removed');
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not remove the group icon'));
      } finally {
        setIconBusy(false);
      }
    }, [dmChannelId]);

    return (
      <Dialog open={isOpen}>
        <DialogContent onInteractOutside={close} close={close}>
          <DialogHeader>
            <DialogTitle>Group Settings</DialogTitle>
            <DialogDescription>
              The name and icon everyone in this group sees.
            </DialogDescription>
          </DialogHeader>

          <Group label="Icon" description="Square images look best. Up to 3 MB.">
            <div className="flex items-center gap-3">
              <Avatar className="h-16 w-16">
                <AvatarImage src={getFileUrl(channel?.icon)} alt="" />
                <AvatarFallback
                  className={cn('text-sm', groupAvatarFallbackClass(dmChannelId))}
                >
                  {getInitialsFromName(channel?.name || fallbackName)}
                </AvatarFallback>
              </Avatar>
              <Button variant="outline" onClick={changeIcon} disabled={iconBusy}>
                <Upload className="h-4 w-4" />
                {channel?.icon ? 'Change icon' : 'Upload icon'}
              </Button>
              {channel?.icon && (
                <Button
                  variant="ghost"
                  onClick={removeIcon}
                  disabled={iconBusy}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove
                </Button>
              )}
            </div>
          </Group>

          <Group
            label="Name"
            description="Leave empty to show the members' names instead."
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={fallbackName}
              maxLength={100}
              onEnter={saveName}
            />
          </Group>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={saveName} disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export { GroupDmSettingsDialog };
