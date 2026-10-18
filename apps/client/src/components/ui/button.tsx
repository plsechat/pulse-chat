import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/*
 * Only the icon sizes refuse to shrink: a square button that gives way
 * loses its glyph. Text sizes get `min-w-0` and a truncating label span
 * instead, so in a flex row that runs out of width the label elides
 * rather than the whole row overflowing (and getting clipped by the
 * nearest `overflow-hidden`). Icon sizes match real use: `icon` is the
 * 36 px default, `icon-sm` the 32 px composer/toolbar size, `icon-xs`
 * the 24 px inline size.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost:
          'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-9 min-w-0 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 min-w-0 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 min-w-0 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9 shrink-0',
        'icon-sm': 'size-8 shrink-0',
        'icon-xs': 'size-6 shrink-0'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

/**
 * Wraps the button's text in one truncating span so a label can elide.
 * Adjacent text and number children (`{count} items`) collapse into a
 * single span, keeping the flex gap between icon and label only.
 * Element children (icons, badges) pass through untouched, so
 * `has-[>svg]` padding still sees the svg as a direct child.
 */
const wrapTextChildren = (children: React.ReactNode): React.ReactNode => {
  const out: React.ReactNode[] = [];
  let text = '';
  const flush = () => {
    if (text === '') return;
    out.push(
      <span key={`t${out.length}`} className="truncate">
        {text}
      </span>
    );
    text = '';
  };
  React.Children.forEach(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      text += String(child);
      return;
    }
    flush();
    if (child !== null && child !== undefined && typeof child !== 'boolean') {
      out.push(child);
    }
  });
  flush();
  return out.length === 1 ? out[0] : out;
};

function Button({
  className,
  variant,
  size,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {asChild ? children : wrapTextChildren(children)}
    </Comp>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
