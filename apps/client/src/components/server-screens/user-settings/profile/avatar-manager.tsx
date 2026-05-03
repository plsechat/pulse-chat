import { Button } from '@/components/ui/button';
import { Group } from '@/components/ui/group';
import { UserAvatar } from '@/components/user-avatar';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { uploadFile } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedPublicUser } from '@pulse/shared';
import { Upload } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { AvatarCropDialog } from './avatar-crop-dialog';

type TAvatarManagerProps = {
  user: TJoinedPublicUser;
};

const AvatarManager = memo(({ user }: TAvatarManagerProps) => {
  const openFilePicker = useFilePicker();
  // Holds the file the user just picked while the crop dialog is open.
  // null means no crop is in progress; the dialog renders only when set.
  const [pickedFile, setPickedFile] = useState<File | null>(null);

  const removeAvatar = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.users.changeAvatar.mutate({ fileId: undefined });

      toast.success('Avatar removed successfully!');
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not remove avatar. Please try again.'));
    }
  }, []);

  const onAvatarClick = useCallback(async () => {
    try {
      const [file] = await openFilePicker('image/*');
      // Defer upload until the user has confirmed a crop region in
      // the dialog — uploading the raw file and then cropping after
      // would waste bandwidth on the discarded portion of the image.
      setPickedFile(file);
    } catch {
      // openFilePicker rejects when the dialog is dismissed; that's
      // a user-initiated cancel, not an error worth surfacing.
    }
  }, [openFilePicker]);

  const handleCropConfirm = useCallback(async (cropped: File) => {
    setPickedFile(null);
    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      const temporaryFile = await uploadFile(cropped);

      if (!temporaryFile) {
        toast.error('Could not upload file. Please try again.');
        return;
      }

      await trpc.users.changeAvatar.mutate({ fileId: temporaryFile.id });

      toast.success('Avatar updated successfully!');
    } catch (err) {
      toast.error(
        getTrpcError(err, 'Could not update avatar. Please try again.')
      );
    }
  }, []);

  const handleCropCancel = useCallback(() => {
    setPickedFile(null);
  }, []);

  return (
    <Group label="Avatar">
      <div className="space-y-2">
        <div
          className="relative group cursor-pointer w-32 h-32"
          onClick={onAvatarClick}
        >
          <UserAvatar
            userId={user.id}
            className="h-32 w-32 rounded-full bg-muted transition-opacity group-hover:opacity-30"
            showStatusBadge={false}
            showUserPopover={false}
          />
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full">
            <div className="bg-black/50 rounded-full p-3">
              <Upload className="h-6 w-6 text-white" />
            </div>
          </div>
        </div>
      </div>
      {user.avatarId && (
        <div>
          <Button size="sm" variant="outline" onClick={removeAvatar}>
            Remove avatar
          </Button>
        </div>
      )}
      {pickedFile && (
        <AvatarCropDialog
          file={pickedFile}
          open
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}
    </Group>
  );
});

export { AvatarManager };
