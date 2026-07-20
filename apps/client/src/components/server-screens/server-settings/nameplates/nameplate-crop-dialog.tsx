import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Wide strip matching the member-row render (right-anchored, ~5:1).
const VIEWPORT_W = 440;
const VIEWPORT_H = 88;
const OUTPUT_W = 1200;
const OUTPUT_H = 240;
const MAX_ZOOM = 4;
const OUTPUT_TYPE = 'image/jpeg';
const OUTPUT_QUALITY = 0.92;

type TNameplateCropDialogProps = {
  file: File;
  open: boolean;
  onConfirm: (cropped: File) => void;
  onCancel: () => void;
};

/**
 * Crop step between "admin picked an image" and the upload form — the
 * same cover-fit pan/zoom mechanics as the avatar crop, generalized to
 * the nameplate's wide aspect so imported art lands pre-framed for the
 * member-row strip.
 */
const NameplateCropDialog = memo(
  ({ file, open, onConfirm, onCancel }: TNameplateCropDialogProps) => {
    const objectUrl = useMemo(() => URL.createObjectURL(file), [file]);
    useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl]);

    const imgRef = useRef<HTMLImageElement | null>(null);
    const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(
      null
    );
    const [zoom, setZoom] = useState(1);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{
      startX: number;
      startY: number;
      origX: number;
      origY: number;
    } | null>(null);

    const fitScale = useMemo(() => {
      if (!imgNatural) return 1;
      // Cover-fit against BOTH axes of the wide viewport.
      return Math.max(VIEWPORT_W / imgNatural.w, VIEWPORT_H / imgNatural.h);
    }, [imgNatural]);

    const effectiveScale = fitScale * zoom;

    const clampPosition = useCallback(
      (next: { x: number; y: number }) => {
        if (!imgNatural) return next;
        const dispW = imgNatural.w * effectiveScale;
        const dispH = imgNatural.h * effectiveScale;
        const maxX = Math.max(0, (dispW - VIEWPORT_W) / 2);
        const maxY = Math.max(0, (dispH - VIEWPORT_H) / 2);
        return {
          x: Math.max(-maxX, Math.min(maxX, next.x)),
          y: Math.max(-maxY, Math.min(maxY, next.y))
        };
      },
      [imgNatural, effectiveScale]
    );

    useEffect(() => {
      setPosition((prev) => clampPosition(prev));
    }, [clampPosition]);

    const handleImgLoad = useCallback(() => {
      const img = imgRef.current;
      if (!img) return;
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setPosition({ x: 0, y: 0 });
      setZoom(1);
    }, []);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          origX: position.x,
          origY: position.y
        };
      },
      [position]
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPosition(
          clampPosition({
            x: dragRef.current.origX + dx,
            y: dragRef.current.origY + dy
          })
        );
      },
      [clampPosition]
    );

    const handlePointerUp = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        dragRef.current = null;
      },
      []
    );

    const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.0008;
      setZoom((z) => Math.max(1, Math.min(MAX_ZOOM, z + delta * z)));
    }, []);

    const handleConfirm = useCallback(async () => {
      const img = imgRef.current;
      if (!img || !imgNatural) return;

      const sx =
        (imgNatural.w * effectiveScale - VIEWPORT_W) / 2 / effectiveScale -
        position.x / effectiveScale;
      const sy =
        (imgNatural.h * effectiveScale - VIEWPORT_H) / 2 / effectiveScale -
        position.y / effectiveScale;
      const sWidth = VIEWPORT_W / effectiveScale;
      const sHeight = VIEWPORT_H / effectiveScale;

      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_W;
      canvas.height = OUTPUT_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, OUTPUT_W, OUTPUT_H);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), OUTPUT_TYPE, OUTPUT_QUALITY)
      );
      if (!blob) return;
      const cropped = new File([blob], `nameplate-${Date.now()}.jpg`, {
        type: OUTPUT_TYPE
      });
      onConfirm(cropped);
    }, [effectiveScale, imgNatural, onConfirm, position.x, position.y]);

    return (
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) onCancel();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Crop nameplate</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col items-center gap-4 py-2">
            <p className="text-sm text-muted-foreground self-start">
              Frame the strip members will see — keep the art weighted to
              the right, it fades out toward the name.
            </p>
            <div
              className="relative overflow-hidden rounded-md bg-muted touch-none cursor-grab active:cursor-grabbing select-none"
              style={{ width: VIEWPORT_W, height: VIEWPORT_H }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
            >
              <img
                ref={imgRef}
                src={objectUrl}
                alt=""
                onLoad={handleImgLoad}
                draggable={false}
                className="absolute left-1/2 top-1/2 max-w-none pointer-events-none"
                style={{
                  width: imgNatural ? imgNatural.w : 'auto',
                  height: imgNatural ? imgNatural.h : 'auto',
                  transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${effectiveScale})`,
                  transformOrigin: 'center center'
                }}
              />
              {/* Live fade hint mirroring the member-row mask */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'linear-gradient(to right, rgba(0,0,0,0.55) 0%, transparent 55%)'
                }}
              />
            </div>

            <div className="w-full space-y-1">
              <label className="text-xs text-muted-foreground">Zoom</label>
              <Slider
                min={1}
                max={MAX_ZOOM}
                step={0.05}
                value={[zoom]}
                onValueChange={([v]) => setZoom(v)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={!imgNatural}>
              Crop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

NameplateCropDialog.displayName = 'NameplateCropDialog';

export { NameplateCropDialog };
