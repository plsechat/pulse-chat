import { EmojiPicker } from '@/components/emoji-picker';
import { Button } from '@/components/ui/button';
import { useChannels } from '@/features/server/channels/hooks';
import { useCustomEmojis } from '@/features/server/emojis/hooks';
import { useRoles } from '@/features/server/roles/hooks';
import { useOwnUserId, useUsers } from '@/features/server/users/hooks';
import { isCoarsePointer } from '@/hooks/use-is-mobile';
import { onAppEvent } from '@/lib/events';
import { cn } from '@/lib/utils';
import type { TCommandInfo } from '@pulse/shared';
import type { AnyExtension, Editor } from '@tiptap/core';
import Emoji, { gitHubEmojis } from '@tiptap/extension-emoji';
import Placeholder from '@tiptap/extension-placeholder';
import { liftListItem, splitListItem } from '@tiptap/pm/schema-list';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Smile } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CommandHint } from './command-hint';
import { FormatBar } from './format-bar';
import { ChannelMentionExtension } from './plugins/channel-mention-extension';
import {
  CHANNEL_MENTION_STORAGE_KEY,
  ChannelMentionSuggestion
} from './plugins/channel-mention-suggestion';
import {
  commandQueryFromText,
  resolveUsageHint,
  type TUsageHint
} from './plugins/command-palette';
import {
  COMMANDS_STORAGE_KEY,
  CommandSuggestion
} from './plugins/command-suggestion';
import { CustomEmojiNode } from './plugins/custom-emoji-extension';
import { MarkdownUnderline, StarOnlyBold } from './plugins/markdown-extensions';
import { MentionExtension } from './plugins/mention-extension';
import {
  MENTION_STORAGE_KEY,
  MentionSuggestion
} from './plugins/mention-suggestion';
import { SlashCommands } from './plugins/slash-commands-extension';
import { EmojiSuggestion } from './suggestions';
import type { TEmojiItem } from './types';

type TMentionableUser = {
  id: number;
  name: string;
  avatar?: { name: string } | null;
  _identity?: string;
};

type TTiptapInputProps = {
  disabled?: boolean;
  value?: string;
  placeholder?: string;
  onChange?: (html: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  onTyping?: () => void;
  commands?: TCommandInfo[];
  /** When set, only these users appear in @mention (no roles, no @all) */
  dmMembers?: TMentionableUser[];
  /**
   * When true, swap Enter and Shift+Enter: plain Enter inserts a newline,
   * Shift+Enter sends. Used by the expanded-composer mode so the user can
   * draft multi-line messages without each Enter sending early.
   */
  multilineMode?: boolean;
  /** Show the formatting bar under the editor (channel and DM composers). */
  toolbar?: boolean;
  /**
   * Controls rendered inside the editor row, before the editor and after
   * the emoji button. The composers pass their attach / GIF / send
   * buttons here so every button is a sibling in ONE row centred on the
   * text; centred against the whole column (editor + format bar) they
   * sat ~14 px above the emoji button.
   */
  leading?: ReactNode;
  trailing?: ReactNode;
};

const TiptapInput = memo(
  ({
    toolbar = false,
    value,
    placeholder,
    onChange,
    onSubmit,
    onCancel,
    onTyping,
    disabled,
    commands,
    dmMembers,
    multilineMode,
    leading,
    trailing
  }: TTiptapInputProps) => {
    const customEmojis = useCustomEmojis();
    const users = useUsers();
    const roles = useRoles();
    const channels = useChannels();
    const ownUserId = useOwnUserId();
    const isDm = !!dmMembers;

    // The TipTap editor instance only binds `editorProps.handleKeyDown` once
    // (the closure captures the prop at editor-creation time). Mirror the
    // current multiline flag through a ref so the handler always reads the
    // latest value without rebuilding the editor.
    const multilineModeRef = useRef(multilineMode);
    useEffect(() => {
      multilineModeRef.current = multilineMode;
    }, [multilineMode]);

    // The usage line for the command being typed (`/watch seek <seconds>`),
    // keyed by the query it was computed for; Escape puts that query
    // aside until the text changes. Both are mirrored through refs for
    // the key handler, which is bound once.
    const [usage, setUsage] = useState<{ query: string; hint: TUsageHint } | null>(null);
    const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
    const usageRef = useRef(usage);
    const dismissedRef = useRef(dismissedQuery);
    useEffect(() => {
      usageRef.current = usage;
      dismissedRef.current = dismissedQuery;
    }, [usage, dismissedQuery]);

    const mentionUsers = useMemo(
      () =>
        dmMembers ??
        users.map((u) => ({
          id: u.id,
          name: u.name,
          avatar: u.avatar,
          _identity: u._identity
        })),
      [dmMembers, users]
    );

    const mentionRoles = useMemo(
      () =>
        isDm
          ? []
          : roles.map((r) => ({ id: r.id, name: r.name, color: r.color })),
      [isDm, roles]
    );

    const mentionChannels = useMemo(() => {
      if (isDm) return [];

      const forumIds = new Set(
        channels.filter((c) => c.type === 'FORUM').map((c) => c.id)
      );
      const forumNameMap = new Map(
        channels.filter((c) => c.type === 'FORUM').map((c) => [c.id, c.name])
      );

      return channels
        .filter(
          (c) =>
            c.type === 'TEXT' ||
            (c.type === 'THREAD' && forumIds.has(c.parentChannelId!))
        )
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parentName:
            c.type === 'THREAD'
              ? forumNameMap.get(c.parentChannelId!)
              : undefined
        }));
    }, [isDm, channels]);

    const extensions = useMemo(() => {
      const exts: AnyExtension[] = [
        StarterKit.configure({
          // Use our customized Bold (`**` only) and Underline (`__`) so the
          // markdown shortcuts in the formatting hint bar match what the
          // renderer parses. StarterKit's default Bold owns both `**` and
          // `__`, which silently masked the Underline mark.
          bold: false,
          underline: false,
          hardBreak: {
            HTMLAttributes: {
              class: 'hard-break'
            }
          }
        }),
        StarOnlyBold,
        MarkdownUnderline,
        Placeholder.configure({
          placeholder: placeholder ?? 'Message...'
        }),
        Emoji.configure({
          emojis: [...gitHubEmojis, ...customEmojis],
          enableEmoticons: true,
          suggestion: EmojiSuggestion,
          HTMLAttributes: {
            class: 'emoji-image'
          }
        }),
        CustomEmojiNode,
        MentionExtension.configure({
          users: mentionUsers,
          roles: mentionRoles,
          isDm,
          ownUserId: ownUserId ?? 0,
          suggestion: MentionSuggestion
        })
      ];

      if (!isDm) {
        exts.push(
          ChannelMentionExtension.configure({
            channels: mentionChannels,
            suggestion: ChannelMentionSuggestion
          })
        );
      }

      if (commands) {
        exts.push(
          SlashCommands.configure({
            commands,
            suggestion: CommandSuggestion
          })
        );
      }

      return exts;
    }, [
      customEmojis,
      commands,
      mentionUsers,
      mentionRoles,
      mentionChannels,
      isDm,
      ownUserId,
      placeholder
    ]);

    // What `/…` before the cursor means, for the hint above the editor.
    const trackCommandUsage = (editor: Editor) => {
      // A destroyed editor has no state (Tiptap 3.3 nulls the view and the
      // schema on destroy); the hook can still hand us the old instance
      // for one render after a remount.
      if (editor.isDestroyed) return;
      const commandList = editor.storage[COMMANDS_STORAGE_KEY]?.commands;
      if (!commandList || commandList.length === 0) {
        if (usageRef.current) setUsage(null);
        return;
      }
      const { from } = editor.state.selection;
      const query = commandQueryFromText(editor.state.doc.textBetween(0, from, '\n'));
      const hint = query !== null ? resolveUsageHint(commandList, query) : null;
      const next = hint && query !== null ? { query, hint } : null;
      if (next?.query === usageRef.current?.query && (next === null) === (usageRef.current === null)) return;
      setUsage(next);
    };

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

        trackCommandUsage(editor);
      },
      onSelectionUpdate: ({ editor }) => {
        trackCommandUsage(editor);
      },
      editorProps: {
        handlePaste: (_view, event) => {
          const text = event.clipboardData?.getData('text/plain');
          if (!text) return false;

          event.preventDefault();

          // Detect code: clipboard came from a code block, or text contains HTML/XML tags
          const html = event.clipboardData?.getData('text/html') ?? '';
          const fromCodeBlock =
            /<pre[\s>]/i.test(html) || /<code[\s>]/i.test(html);
          const hasMarkup = /<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/i.test(text);

          if (fromCodeBlock || hasMarkup) {
            // Use insertText so TipTap treats the string as literal text,
            // not as HTML (otherwise `<p>html</p>` would create a paragraph node).
            editor
              ?.chain()
              .focus()
              .setCodeBlock()
              .command(({ tr, dispatch }) => {
                if (dispatch) tr.insertText(text);
                return true;
              })
              .run();
          } else {
            editor?.commands.insertContent(text);
          }
          return true;
        },
        handleKeyDown: (view, event) => {
          const suggestionElement = document.querySelector(
            '[data-tiptap-suggestion]'
          );
          const hasSuggestions =
            suggestionElement && document.body.contains(suggestionElement);

          // Inside a code block, Tab indents (and Shift+Tab outdents)
          // instead of moving focus out of the composer.
          if (event.key === 'Tab') {
            const { $from } = view.state.selection;
            if ($from.parent.type.name === 'codeBlock') {
              event.preventDefault();
              if (event.shiftKey) {
                // Outdent: strip up to two leading spaces from the
                // current line (code blocks are a single text node with
                // \n separators).
                const blockStart = $from.start();
                const beforeCursor = view.state.doc.textBetween(
                  blockStart,
                  $from.pos,
                  '\n'
                );
                const lineStart =
                  blockStart + beforeCursor.lastIndexOf('\n') + 1;
                const lineHead = view.state.doc.textBetween(
                  lineStart,
                  Math.min(lineStart + 2, $from.end()),
                  '\n'
                );
                const stripCount = lineHead.startsWith('  ')
                  ? 2
                  : lineHead.startsWith(' ')
                    ? 1
                    : 0;
                if (stripCount > 0) {
                  view.dispatch(
                    view.state.tr.delete(lineStart, lineStart + stripCount)
                  );
                }
              } else {
                view.dispatch(view.state.tr.insertText('  '));
              }
              return true;
            }
          }

          if (event.key === 'Enter') {
            // Touch-first devices: Enter inserts a newline and the Send
            // button sends — a soft keyboard has no Shift+Enter, so
            // Enter-sends made multi-line messages impossible. Only the
            // composers that offer a multiline mode (and therefore have
            // a Send button) opt in; the inline editor and the profile
            // card composer pass no `multilineMode` and keep Enter =
            // submit, since they have no other way to submit.
            const isMultiline =
              !!multilineModeRef.current ||
              (multilineModeRef.current !== undefined && isCoarsePointer());

            // Multiline mode: Shift+Enter sends, plain Enter inserts a
            // newline (which is the inverse of the default). Suggestions
            // and lists still need their special-case handling.
            if (isMultiline) {
              if (event.shiftKey) {
                if (hasSuggestions) return false;
                const { $from } = view.state.selection;
                if ($from.parent.type.name === 'codeBlock') return false;
                event.preventDefault();
                onSubmit?.();
                return true;
              }
              // Plain Enter — defer to TipTap's list/codeBlock handling
              // (splitListItem etc.) and otherwise insert a newline. We
              // return false to let the default keymap take over.
              return false;
            }

            if (event.shiftKey) {
              // Inside a list, repurpose Shift+Enter to advance to the next
              // list item — plain Enter is reserved for sending. An empty
              // list item under Shift+Enter exits the list, matching what
              // most markdown editors do for plain Enter inside a list.
              const { $from: shiftFrom } = view.state.selection;
              let inListItem = false;
              for (let depth = shiftFrom.depth; depth > 0; depth--) {
                if (shiftFrom.node(depth).type.name === 'listItem') {
                  inListItem = true;
                  break;
                }
              }
              if (inListItem) {
                event.preventDefault();
                const listItemType = view.state.schema.nodes.listItem;
                const split = splitListItem(listItemType);
                const lift = liftListItem(listItemType);
                if (!split(view.state, view.dispatch)) {
                  lift(view.state, view.dispatch);
                }
                return true;
              }
              // Outside lists, fall through to TipTap's default hardBreak.
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
            // A command palette or usage hint closes first; the
            // suggestion plugin owns its list (returning false hands
            // the key to it), the hint is ours.
            const usageShown =
              usageRef.current !== null &&
              dismissedRef.current !== usageRef.current.query;
            if (usageShown) setDismissedQuery(usageRef.current!.query);
            if (hasSuggestions) return false;
            if (usageShown) {
              event.preventDefault();
              return true;
            }
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
      } else if (emoji.id && emoji.fallbackImage) {
        // Custom server emoji — insert as customEmoji node (bypasses stale options lookup)
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: 'customEmoji',
            attrs: { id: emoji.id, name: emoji.name, src: emoji.fallbackImage }
          })
          .run();
      } else if (emoji.shortcodes.length > 0) {
        // Fallback — use setEmoji for any non-custom emoji with shortcodes
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
        const storage = editor.storage[COMMANDS_STORAGE_KEY];
        if (storage) {
          storage.commands = commands;
        }
      }
    }, [editor, commands]);

    // keep mention storage in sync with users and roles from the store
    useEffect(() => {
      if (editor) {
        const storage = editor.storage[MENTION_STORAGE_KEY];
        if (storage) {
          storage.users = mentionUsers;
          storage.roles = mentionRoles;
          storage.isDm = isDm;
          storage.ownUserId = ownUserId ?? 0;
        }
      }
    }, [editor, mentionUsers, mentionRoles, isDm, ownUserId]);

    // keep channel mention storage in sync with channels from the store
    useEffect(() => {
      if (editor && !isDm) {
        const storage = editor.storage[CHANNEL_MENTION_STORAGE_KEY];
        if (storage) {
          storage.channels = mentionChannels;
        }
      }
    }, [editor, mentionChannels, isDm]);

    useEffect(() => {
      // Never read a destroyed editor: `getHTML()` serialises against a
      // schema that is null once the instance is torn down, and the
      // instance from the previous render can reach this effect after a
      // remount (conversation switch, deps change).
      if (editor && !editor.isDestroyed && value !== undefined) {
        const currentContent = editor.getHTML();

        // only update if content is actually different to avoid cursor jumping
        if (currentContent !== value) {
          editor.commands.setContent(value);
        }
      }
    }, [editor, value]);

    useEffect(() => {
      if (editor && !editor.isDestroyed) {
        editor.setEditable(!disabled);
      }
    }, [editor, disabled]);

    // Listen for external mention-user events (e.g. from UserContextMenu)
    useEffect(() => {
      const handler = ({
        userId,
        username
      }: {
        userId: number;
        username: string;
      }) => {
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
      return onAppEvent('mention-user', handler);
    }, [editor]);

    // One row for the editor and every button around it. Single line:
    // all centred on the text. Multiline (the drag-resized composer):
    // the editor stretches and scrolls on its own, the buttons sit on
    // its bottom edge, right above the format bar.
    const row = (
      <div
        className={cn(
          'flex min-w-0 flex-1 gap-2',
          multilineMode ? 'min-h-0 items-end' : 'items-center',
          !disabled && 'cursor-text'
        )}
        onClick={(e) => {
          if (disabled) return;
          if ((e.target as HTMLElement).closest('button')) return;
          editor?.chain().focus().run();
        }}
      >
        {leading}
        <EditorContent
          editor={editor}
          className={cn(
            'tiptap min-w-0 flex-1',
            multilineMode && 'min-h-0 self-stretch overflow-y-auto',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        />

        <EmojiPicker onEmojiSelect={handleEmojiSelect}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-primary"
            disabled={disabled}
            aria-label="Add emoji"
          >
            <Smile className="h-5 w-5" />
          </Button>
        </EmojiPicker>
        {trailing}
      </div>
    );

    const hint =
      usage && dismissedQuery !== usage.query ? (
        <CommandHint hint={usage.hint} />
      ) : null;

    if (!toolbar && !hint) return row;

    return (
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          multilineMode && 'min-h-0 self-stretch'
        )}
      >
        {hint}
        {row}
        {toolbar && <FormatBar editor={editor} disabled={disabled} />}
      </div>
    );
  }
);

export { TiptapInput };
export type { TMentionableUser };
