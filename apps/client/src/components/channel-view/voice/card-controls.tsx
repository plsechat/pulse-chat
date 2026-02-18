import { memo } from 'react';

type TCardControlsProps = {
  children?: React.ReactNode;
};

const CardControls = memo(({ children }: TCardControlsProps) => {
  return (
    <div
      className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center gap-1 pointer-events-auto cursor-default"
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
});

export { CardControls };
