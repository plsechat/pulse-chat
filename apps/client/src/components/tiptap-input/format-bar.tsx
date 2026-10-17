import { cn } from '@/lib/utils';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Code,
  Italic,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Strikethrough,
  Underline
} from 'lucide-react';
import { memo } from 'react';

/**
 * The composer's formatting bar: one button per mark or block the
 * renderer understands, lit while the caret sits inside that format.
 * Reads the editor through useEditorState so the bar re-renders on
 * selection changes only, not on every keystroke elsewhere.
 */

type TAction = {
  key: string;
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  isActive: (e: Editor) => boolean;
  run: (e: Editor) => void;
};

const ACTIONS: TAction[] = [
  {
    key: 'bold',
    label: 'Bold',
    shortcut: 'Ctrl+B',
    icon: <Bold className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run()
  },
  {
    key: 'italic',
    label: 'Italic',
    shortcut: 'Ctrl+I',
    icon: <Italic className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run()
  },
  {
    key: 'underline',
    label: 'Underline',
    shortcut: 'Ctrl+U',
    icon: <Underline className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('underline'),
    run: (e) => e.chain().focus().toggleUnderline().run()
  },
  {
    key: 'strike',
    label: 'Strikethrough',
    icon: <Strikethrough className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run()
  },
  {
    key: 'code',
    label: 'Inline code',
    icon: <Code className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('code'),
    run: (e) => e.chain().focus().toggleCode().run()
  },
  {
    key: 'codeBlock',
    label: 'Code block',
    icon: <SquareCode className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('codeBlock'),
    run: (e) => e.chain().focus().toggleCodeBlock().run()
  },
  {
    key: 'blockquote',
    label: 'Quote',
    icon: <Quote className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run()
  },
  {
    key: 'bulletList',
    label: 'Bulleted list',
    icon: <List className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run()
  },
  {
    key: 'orderedList',
    label: 'Numbered list',
    icon: <ListOrdered className="h-3.5 w-3.5" />,
    isActive: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run()
  }
];

const FormatBar = memo(
  ({ editor, disabled }: { editor: Editor | null; disabled?: boolean }) => {
    const active = useEditorState({
      editor,
      selector: ({ editor: e }) =>
        e ? ACTIONS.map((a) => a.isActive(e)) : ACTIONS.map(() => false)
    });

    if (!editor) return null;

    return (
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex items-center gap-0.5 pt-1"
      >
        {ACTIONS.map((action, i) => (
          <button
            key={action.key}
            type="button"
            disabled={disabled}
            aria-label={action.label}
            aria-pressed={active?.[i] ?? false}
            title={
              action.shortcut
                ? `${action.label} (${action.shortcut})`
                : action.label
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => action.run(editor)}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40',
              active?.[i] && 'bg-accent text-foreground'
            )}
          >
            {action.icon}
          </button>
        ))}
      </div>
    );
  }
);

export { FormatBar };
