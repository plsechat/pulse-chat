import type { TCommandInfo } from '@pulse/shared';
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import type { TPaletteItem } from './command-palette';
import { COMMANDS_STORAGE_KEY, CommandSuggestion } from './command-suggestion';

export const SlashCommandsPluginKey = new PluginKey('slashCommands');

export interface SlashCommandsOptions {
  commands: TCommandInfo[];
  suggestion: typeof CommandSuggestion;
}

export const SlashCommands = Extension.create<SlashCommandsOptions>({
  name: COMMANDS_STORAGE_KEY,
  addOptions() {
    return {
      commands: [],
      suggestion: CommandSuggestion
    };
  },
  addStorage() {
    return {
      commands: this.options.commands
    };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<TPaletteItem, TPaletteItem>({
        editor: this.editor,
        pluginKey: SlashCommandsPluginKey,
        char: this.options.suggestion.char,
        startOfLine: this.options.suggestion.startOfLine,
        allowSpaces: this.options.suggestion.allowSpaces,
        items: this.options.suggestion.items,
        render: this.options.suggestion.render,
        // A row replaces the whole `/…` run with what it stands for:
        // `/watch `, `/watch pause `, `/deploy prod ` (the palette
        // rebuilds the text so a choice keeps what came before it).
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(props.insert)
            .run();
        }
      })
    ];
  }
});
