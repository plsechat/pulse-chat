import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { Copy, Download, ExternalLink } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TImageContextMenuProps = {
  src: string;
  filename?: string;
  children: React.ReactNode;
};

/** Convert any image blob to PNG via canvas — used as a clipboard fallback. */
async function convertBlobToPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
        'image/png'
      )
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

const ImageContextMenu = memo(
  ({ src, filename, children }: TImageContextMenuProps) => {
    const onCopy = useCallback(async () => {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        // Prefer the original MIME type so animated GIFs / WebP keep
        // their semantics; fall back to PNG for browsers that only
        // accept image/png in the clipboard (Safari).
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);
        } catch {
          const png = await convertBlobToPng(blob);
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': png })
          ]);
        }
        toast.success('Image copied');
      } catch (err) {
        console.error('[ImageContextMenu] copy failed:', err);
        toast.error('Could not copy image');
      }
    }, [src]);

    const onSave = useCallback(async () => {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename || 'image';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        console.error('[ImageContextMenu] save failed:', err);
        toast.error('Could not save image');
      }
    }, [src, filename]);

    const onOpenNewTab = useCallback(() => {
      window.open(src, '_blank', 'noopener,noreferrer');
    }, [src]);

    return (
      // Stop the contextmenu from bubbling to the message-level
      // ContextMenuTrigger that wraps the whole message. Without this both
      // menus race; the outer one usually wins because radix doesn't
      // automatically stop propagation across nested triggers in v1.
      <div onContextMenu={(e) => e.stopPropagation()} className="contents">
        <ContextMenu>
          <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem onClick={onCopy}>
              <Copy className="h-4 w-4" />
              Copy Image
            </ContextMenuItem>
            <ContextMenuItem onClick={onSave}>
              <Download className="h-4 w-4" />
              Save Image
            </ContextMenuItem>
            <ContextMenuItem onClick={onOpenNewTab}>
              <ExternalLink className="h-4 w-4" />
              Open in New Tab
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    );
  }
);

export { ImageContextMenu };
