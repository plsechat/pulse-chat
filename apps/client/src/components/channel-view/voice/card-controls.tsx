import { memo } from 'react';

type TCardControlsProps = {
  children?: React.ReactNode;
};

/**
 * Top-right control cluster of a voice/screen tile. Revealed on hover
 * where hovering exists and always on touch screens (`group-hover-or-
 * touch`, index.css) — a hover-only reveal is invisible on a phone.
 * Pointer and mouse events stop here so a tap on a control never
 * starts the tile's drag / click-focus / zoom-pan.
 */
const CardControls = memo(({ children }: TCardControlsProps) => {
  return (
    <div
      className="absolute top-1.5 right-1.5 opacity-0 group-hover-or-touch:opacity-100 transition-opacity z-20 flex items-center gap-1 pointer-events-auto cursor-default"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
});

export { CardControls };
