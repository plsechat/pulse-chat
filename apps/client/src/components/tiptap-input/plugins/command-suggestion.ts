import { computePosition } from '@floating-ui/dom';
import type { TCommandInfo } from '@pulse/shared';
import type { Editor } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import type {
  SuggestionKeyDownProps,
  SuggestionProps
} from '@tiptap/suggestion';
import { CommandList, type CommandListRef } from './command-list';
import { resolvePalette, type TPaletteItem } from './command-palette';

const COMMANDS_STORAGE_KEY = 'slashCommands';

export type TSlashCommandsStorage = {
  commands: TCommandInfo[];
};

declare module '@tiptap/core' {
  interface Storage {
    [COMMANDS_STORAGE_KEY]: TSlashCommandsStorage;
  }
}

type TCommandSuggestionProps = SuggestionProps<TPaletteItem, TPaletteItem>;

const storedCommands = (editor: Editor): TCommandInfo[] =>
  editor.storage[COMMANDS_STORAGE_KEY]?.commands ?? [];

/**
 * The `/` suggestion: `query` is everything after the slash up to the
 * cursor (spaces included), and the palette decides what that means —
 * see command-palette.ts. Nothing is offered while an argument without
 * choices is typed, so Enter sends.
 */
export const CommandSuggestion = {
  char: '/',
  startOfLine: true,
  items: ({ editor, query }: { editor: Editor; query: string }): TPaletteItem[] =>
    resolvePalette(storedCommands(editor), query)?.items ?? [],
  allowSpaces: true,
  render: () => {
    let component: ReactRenderer | null = null;

    function reposition(clientRect: DOMRect) {
      if (!component?.element) return;

      const virtualElement = { getBoundingClientRect: () => clientRect };

      computePosition(virtualElement, component.element, {
        placement: 'top-start'
      }).then((pos) => {
        if (component?.element) {
          Object.assign(component.element.style, {
            left: `${pos.x}px`,
            top: `${pos.y}px`,
            position: pos.strategy === 'fixed' ? 'fixed' : 'absolute'
          });
        }
      });
    }

    function destroy() {
      if (component?.element && document.body.contains(component.element)) {
        document.body.removeChild(component.element);
      }

      component?.destroy();
      component = null;
    }

    const propsFor = (props: TCommandSuggestionProps) => ({
      palette: resolvePalette(storedCommands(props.editor), props.query),
      onSelect: (item: TPaletteItem) => {
        props.command(item);
        destroy();
      }
    });

    return {
      onStart: (props: TCommandSuggestionProps) => {
        component = new ReactRenderer(CommandList, {
          props: propsFor(props),
          editor: props.editor
        });

        document.body.appendChild(component.element);
        const rect = props.clientRect?.();
        if (rect) {
          reposition(rect);
        }
      },
      onUpdate(props: TCommandSuggestionProps) {
        component?.updateProps(propsFor(props));

        const rect = props.clientRect?.();
        if (rect) {
          reposition(rect);
        }
      },
      onKeyDown(props: SuggestionKeyDownProps) {
        const commandListRef = component?.ref as CommandListRef | undefined;
        if (commandListRef?.onKeyDown) {
          return commandListRef.onKeyDown(props.event);
        }
        return false;
      },
      onExit() {
        destroy();
      }
    };
  }
};

export { COMMANDS_STORAGE_KEY };
