import { ImagePicker } from '@/components/image-picker';
import { Group } from '@/components/ui/group';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { uploadFile } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import type { TFile } from '@pulse/shared';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TLogoManagerProps = {
  logo: TFile | null;
  serverId: number | undefined;
  refetch: () => Promise<void>;
};

const LogoManager = memo(({ logo, serverId, refetch }: TLogoManagerProps) => {
  const openFilePicker = useFilePicker();

  const removeLogo = useCallback(async () => {
    if (!serverId) return;
    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.others.changeLogo.mutate({ serverId, fileId: undefined });
      await refetch();

      toast.success('Logo removed successfully!');
    } catch (error) {
      console.error(error);
      toast.error('Could not remove logo. Please try again.');
    }
  }, [refetch, serverId]);

  const onLogoClick = useCallback(async () => {
    if (!serverId) return;
    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      const [file] = await openFilePicker('image/*');

      const temporaryFile = await uploadFile(file);

      if (!temporaryFile) {
        toast.error('Could not upload file. Please try again.');
        return;
      }

      await trpc.others.changeLogo.mutate({ serverId, fileId: temporaryFile.id });
      await refetch();

      toast.success('Logo updated successfully!');
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not update logo. Please try again.'));
    }
  }, [openFilePicker, refetch, serverId]);

  return (
    <Group label="Logo">
      <ImagePicker
        image={logo}
        onImageClick={onLogoClick}
        onRemoveImageClick={removeLogo}
        className="w-48 h-48"
      />
    </Group>
  );
});

export { LogoManager };
