import { EmojiPicker } from '@/components/emoji-picker';
import { Button } from '@/components/ui/button';
import { useCustomEmojis } from '@/features/server/emojis/hooks';
import { useRoles } from '@/features/server/roles/hooks';
import { useUsers } from '@/features/server/users/hooks';
import type { TCommandInfo } from '@pulse/shared';
import Emoji, { gitHubEmojis } from '@tiptap/extension-emoji';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Smile } from 'lucide-react';
import { MENTION_USER_EVENT } from '@/lib/events';
import { memo, useEffect, useMemo } from 'react';
import {
  COMMANDS_STORAGE_KEY,
  CommandSuggestion
} from './plugins/command-suggestion';
import { MentionExtension } from './plugins/mention-extension';
import {
  MENTION_STORAGE_KEY,
  MentionSuggestion
} from './plugins/mention-suggestion';
import { SlashCommands } from './plugins/slash-commands-extension';
import { EmojiSuggestion } from './suggestions';
import type { TEmojiItem } from './types';

type TTiptapInputProps = {
  disabled?: boolean;
  value?: string;
  placeholder?: string;
  onChange?: (html: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  onTyping?: () => void;
  commands?: TCommandInfo[];
};

const TiptapInput = memo(
  ({
    value,
    placeholder,
    onChange,
    onSubmit,
    onCancel,
    onTyping,
    disabled,
    commands
  }: TTiptapInputProps) => {
    const customEmojis = useCustomEmojis();
    const users = useUsers();
    const roles = useRoles();

    const mentionUsers = useMemo(
      () => users.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar, _identity: u._identity })),
      [users]
    );

    const mentionRoles = useMemo(
      () => roles.map((r) => ({ id: r.id, name: r.name, color: r.color })),
      [roles]
    );

    const extensions = useMemo(() => {
      const exts = [
        StarterKit.configure({
          hardBreak: {
            HTMLAttributes: {
              class: 'hard-break'
            }
          }
        }),
        Emoji.configure({
          emojis: [...gitHubEmojis, ...customEmojis],
          enableEmoticons: true,
          suggestion: EmojiSuggestion,
          HTMLAttributes: {
            class: 'emoji-image'
          }
        }),
        MentionExtension.configure({
          users: mentionUsers,
          roles: mentionRoles,
          suggestion: MentionSuggestion
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      ];

      if (commands) {
        exts.push(
          SlashCommands.configure({
            commands,
            suggestion: CommandSuggestion
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any
        );
      }

      return exts;
    }, [customEmojis, commands, mentionUsers, mentionRoles]);

    const editor = useEditor({
      extensions,
      content: value,
      editable: !disabled,
      onUpdate: ({ editor }) => {
        const html = editor.getHTML();

        onChange?.(html);

        if (!editor.isEmpty) {
          onTyping?.();
        }
      },
      editorProps: {
        attributes: {
          'data-placeholder': placeholder ?? 'Message...'
        },
        handleKeyDown: (view, event) => {
          const suggestionElement = document.querySelector('.bg-popover');
          const hasSuggestions =
            suggestionElement && document.body.contains(suggestionElement);

          if (event.key === 'Enter') {
            if (event.shiftKey) {
              return false;
            }

            // if suggestions are active, don't handle Enter - let the suggestion handle it
            if (hasSuggestions) {
              return false;
            }

            // Inside a code block, Enter creates a new line instead of submitting
            const { $from } = view.state.selection;
            if ($from.parent.type.name === 'codeBlock') {
              return false;
            }

            event.preventDefault();
            onSubmit?.();
            return true;
          }

          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel?.();
            return true;
          }

          return false;
        }
      }
    });

    const handleEmojiSelect = (emoji: TEmojiItem) => {
      if (disabled) return;

      if (emoji.emoji) {
        // Standard emoji — insert native unicode directly (avoids broken GitHub CDN img tags)
        editor?.chain().focus().insertContent(emoji.emoji).run();
      } else if (emoji.shortcodes.length > 0) {
        // Custom emoji — use setEmoji which creates an img node with local server URL
        editor?.chain().focus().setEmoji(emoji.shortcodes[0]).run();
      }
    };

    // keep emoji storage in sync with custom emojis from the store
    // this ensures newly added emojis appear in autocomplete without refreshing the app
    useEffect(() => {
      if (editor && editor.storage.emoji) {
        editor.storage.emoji.emojis = [...gitHubEmojis, ...customEmojis];
      }
    }, [editor, customEmojis]);

    // keep commands storage in sync with plugin commands from the store
    useEffect(() => {
      if (editor && commands) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = editor.storage as any;
        if (storage[COMMANDS_STORAGE_KEY]) {
          storage[COMMANDS_STORAGE_KEY].commands = commands;
        }
      }
    }, [editor, commands]);

    // keep mention storage in sync with users and roles from the store
    useEffect(() => {
      if (editor) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = editor.storage as any;
        if (storage[MENTION_STORAGE_KEY]) {
          storage[MENTION_STORAGE_KEY].users = mentionUsers;
          storage[MENTION_STORAGE_KEY].roles = mentionRoles;
        }
      }
    }, [editor, mentionUsers, mentionRoles]);

    useEffect(() => {
      if (editor && value !== undefined) {
        const currentContent = editor.getHTML();

        // only update if content is actually different to avoid cursor jumping
        if (currentContent !== value) {
          editor.commands.setContent(value);
        }
      }
    }, [editor, value]);

    useEffect(() => {
      if (editor) {
        editor.setEditable(!disabled);
      }
    }, [editor, disabled]);

    // Listen for external mention-user events (e.g. from UserContextMenu)
    useEffect(() => {
      const handler = (e: Event) => {
        const { userId, username } = (e as CustomEvent).detail;
        editor
          ?.chain()
          .focus()
          .insertContent([
            {
              type: MENTION_STORAGE_KEY,
              attrs: {
                'data-mention-type': 'user',
                'data-mention-id': String(userId),
                'data-mention-name': username
              }
            },
            { type: 'text', text: ' ' }
          ])
          .run();
      };
      window.addEventListener(MENTION_USER_EVENT, handler);
      return () => window.removeEventListener(MENTION_USER_EVENT, handler);
    }, [editor]);

    return (
      <div
        className={`flex flex-1 items-center gap-2 ${disabled ? '' : 'cursor-text'}`}
        onClick={(e) => {
          if (disabled) return;
          if ((e.target as HTMLElement).closest('button')) return;
          editor?.chain().focus().run();
        }}
      >
        <EditorContent
          editor={editor}
          className={`w-full tiptap ${
            disabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        />

        <EmojiPicker onEmojiSelect={handleEmojiSelect}>
          <Button variant="ghost" size="icon" disabled={disabled}>
            <Smile className="h-5 w-5" />
          </Button>
        </EmojiPicker>
      </div>
    );
  }
);

export { TiptapInput };
