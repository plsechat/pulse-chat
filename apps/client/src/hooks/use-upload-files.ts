import { useCan, usePublicServerSettings } from '@/features/server/hooks';
import { uploadFiles, uploadEncryptedFiles } from '@/helpers/upload-file';
import { Permission, type TTempFile } from '@pulse/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export type TFileKeyInfo = { key: string; nonce: string; mimeType: string };

const useUploadFiles = (disabled: boolean = false, isE2ee: boolean = false, onAfterUpload?: () => void) => {
  const [files, setFiles] = useState<TTempFile[]>([]);
  const filesRef = useRef<TTempFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadingSize, setUploadingSize] = useState(0);
  const fileKeyMapRef = useRef<Map<string, TFileKeyInfo>>(new Map());
  const settings = usePublicServerSettings();
  const can = useCan();

  // hackers gonna hack
  filesRef.current = files;

  const addFiles = useCallback((files: TTempFile[]) => {
    setFiles((prevFiles) => [...prevFiles, ...files]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prevFiles) => prevFiles.filter((file) => file.id !== id));
    fileKeyMapRef.current.delete(id);
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
    fileKeyMapRef.current.clear();
  }, []);

  const doUpload = useCallback(
    async (filesToUpload: File[]) => {
      if (!filesToUpload.length) return;

      setUploading(true);
      const total = filesToUpload.reduce((acc, file) => acc + file.size, 0);
      setUploadingSize((size) => size + total);

      try {
        if (isE2ee) {
          const results = await uploadEncryptedFiles(filesToUpload);
          const tempFiles: TTempFile[] = [];
          for (const r of results) {
            tempFiles.push(r.tempFile);
            fileKeyMapRef.current.set(r.tempFile.id, {
              key: r.key,
              nonce: r.nonce,
              mimeType: r.mimeType
            });
          }
          addFiles(tempFiles);
        } else {
          const uploaded = await uploadFiles(filesToUpload);
          addFiles(uploaded);
        }
      } finally {
        setUploading(false);
        setUploadingSize((size) => size - total);
        onAfterUpload?.();
      }
    },
    [isE2ee, addFiles, onAfterUpload]
  );

  useEffect(() => {
    if (!settings?.storageUploadEnabled || disabled) return;

    const canUpload = can(Permission.UPLOAD_FILES);

    const handlePaste = async (event: ClipboardEvent) => {
      if (disabled) return;

      if (!canUpload) {
        toast.error('You do not have permission to upload files.');
        return;
      }

      const items = event.clipboardData?.items ?? [];
      const filesToUpload: File[] = [];

      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue;

        const pastedFile = items[i].getAsFile();

        if (!pastedFile) continue;

        filesToUpload.push(pastedFile);
      }

      await doUpload(filesToUpload);
    };

    const handleDrop = async (event: DragEvent) => {
      if (disabled) {
        event.preventDefault();
        return;
      }

      if (!canUpload) {
        toast.error('You do not have permission to upload files.');
        return;
      }

      event.preventDefault();
      const filesToUpload: File[] = [];
      const items = event.dataTransfer?.items ?? [];
      const dFiles = event.dataTransfer?.files ?? [];

      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') {
            const file = items[i].getAsFile();
            if (file) filesToUpload.push(file);
          }
        }
      } else {
        for (let i = 0; i < dFiles.length; i++) {
          filesToUpload.push(dFiles[i]);
        }
      }

      await doUpload(filesToUpload);
    };

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
    };

    document.addEventListener('paste', handlePaste);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('paste', handlePaste);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, [addFiles, can, settings, disabled, doUpload]);

  const handleUploadFiles = useCallback(
    async (filesToUpload: File[]) => {
      if (disabled) return;

      if (!can(Permission.UPLOAD_FILES)) {
        toast.error('You do not have permission to upload files.');
        return;
      }

      if (!settings?.storageUploadEnabled) {
        toast.error('File uploads are disabled on this server.');
        return;
      }

      await doUpload(filesToUpload);
    },
    [disabled, can, settings, doUpload]
  );

  return {
    files,
    removeFile,
    filesRef,
    clearFiles,
    uploading,
    uploadingSize,
    handleUploadFiles,
    fileKeyMapRef
  };
};

export { useUploadFiles };
