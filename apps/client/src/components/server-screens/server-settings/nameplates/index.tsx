import { customNameplateStyle } from '@/components/nameplate/presets';
import { NameplateCropDialog } from './nameplate-crop-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingCard } from '@/components/ui/loading-card';
import Spinner from '@/components/ui/spinner';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { refreshNameplates } from '@/features/nameplates/actions';
import {
  useNameplatePacks,
  useNameplatePacksLoaded
} from '@/features/nameplates/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { uploadFiles } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedNameplate } from '@pulse/shared';
import { Trash2, Upload } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TPackRowProps = {
  pack: TJoinedNameplate;
  instanceDomain?: string;
  onDelete: (pack: TJoinedNameplate) => void;
};

/** One pack, previewed exactly as member rows render it. */
const PackRow = memo(({ pack, instanceDomain, onDelete }: TPackRowProps) => (
  <div className="relative h-12 overflow-hidden rounded-md border border-border/60 bg-muted/40">
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-80 dark:opacity-100"
      style={customNameplateStyle(getFileUrl(pack.file, instanceDomain))}
    />
    <div className="relative flex h-full items-center justify-between px-3">
      <span className="text-sm font-medium truncate">{pack.name}</span>
      <Button size="icon" variant="ghost" onClick={() => onDelete(pack)}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  </div>
));

const Nameplates = memo(() => {
  const packs = useNameplatePacks();
  const loaded = useNameplatePacksLoaded();
  const activeInstanceDomain = useActiveInstanceDomain();
  const openFilePicker = useFilePicker();

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cropSource, setCropSource] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  // Covers direct navigation before the deferred server-switch fetch
  // has landed (or after it failed).
  useEffect(() => {
    if (!loaded) refreshNameplates();
  }, [loaded]);

  // Object URL for the local pre-upload preview; revoke on replace/unmount.
  useEffect(() => {
    if (!pendingFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const pickFile = useCallback(async () => {
    const files = await openFilePicker('image/*');
    if (!files || files.length === 0) return;

    setName(files[0].name.replace(/\.[^/.]+$/, '').slice(0, 32));

    // Animated formats skip the crop step — the canvas crop would
    // flatten them to a single static frame. They upload as-is and
    // render right-anchored/cover like everything else.
    if (files[0].type === 'image/gif') {
      setPendingFile(files[0]);
      return;
    }

    // Crop first — imported art rarely arrives in the strip's wide
    // aspect; the dialog produces the pendingFile the form uploads.
    setCropSource(files[0]);
  }, [openFilePicker]);

  const onCropConfirm = useCallback((cropped: File) => {
    setCropSource(null);
    setPendingFile(cropped);
  }, []);

  const onCropCancel = useCallback(() => {
    setCropSource(null);
  }, []);

  const upload = useCallback(async () => {
    if (!pendingFile || !name.trim()) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    setIsUploading(true);
    try {
      const [tempFile] = await uploadFiles([pendingFile]);
      if (!tempFile) return;

      await trpc.nameplates.add.mutate({
        name: name.trim(),
        tempFileId: tempFile.id
      });

      refreshNameplates();
      setPendingFile(null);
      setName('');
      toast.success('Nameplate uploaded');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to upload nameplate'));
    } finally {
      setIsUploading(false);
    }
  }, [pendingFile, name]);

  const onDelete = useCallback(async (pack: TJoinedNameplate) => {
    const choice = await requestConfirmation({
      title: 'Delete Nameplate',
      message: `Are you sure you want to delete "${pack.name}"? Members currently wearing it will have it removed.`,
      confirmLabel: 'Delete'
    });

    if (!choice) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.nameplates.delete.mutate({ id: pack.id });
      refreshNameplates();
      toast.success('Nameplate deleted');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to delete nameplate'));
    }
  }, []);

  if (!loaded) {
    return <LoadingCard className="h-[400px]" />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload Nameplate</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Nameplates are decorative backgrounds members can equip behind
            their name in the member list. The image is anchored to the
            right of the row and fades out toward the name — keep the art
            on the right side. Max 1 MB.
          </p>

          {pendingFile ? (
            <div className="space-y-4">
              <div className="relative h-12 overflow-hidden rounded-md border border-border/60 bg-muted/40">
                {previewUrl && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-80 dark:opacity-100"
                    style={customNameplateStyle(previewUrl)}
                  />
                )}
                <div className="relative flex h-full items-center px-3">
                  <span className="text-sm font-medium">Preview</span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="nameplate-name">Name</Label>
                <Input
                  id="nameplate-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter nameplate name"
                  maxLength={32}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setPendingFile(null)}
                  disabled={isUploading}
                >
                  Cancel
                </Button>
                <Button
                  onClick={upload}
                  disabled={isUploading || !name.trim()}
                >
                  {isUploading ? (
                    <Spinner size="xs" />
                  ) : (
                    <Upload className="h-4 w-4 mr-2" />
                  )}
                  Upload
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={pickFile}>
              <Upload className="h-4 w-4 mr-2" />
              Choose Image
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nameplates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {packs.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No custom nameplates yet
            </div>
          ) : (
            packs.map((pack) => (
              <PackRow
                key={pack.id}
                pack={pack}
                instanceDomain={activeInstanceDomain ?? undefined}
                onDelete={onDelete}
              />
            ))
          )}
        </CardContent>
      </Card>

      {cropSource && (
        <NameplateCropDialog
          file={cropSource}
          open
          onConfirm={onCropConfirm}
          onCancel={onCropCancel}
        />
      )}
    </div>
  );
});

export { Nameplates };
