import { cn } from '@/lib/utils';
import type { TCommandInfo } from '@pulse/shared';
import { memo } from 'react';

type TCommandsListProps = {
  availableCommands: TCommandInfo[];
  handleCommandChange: (commandName: string) => void;
  selectedCommand: string | null;
};

const CommandsList = memo(
  ({
    availableCommands,
    handleCommandChange,
    selectedCommand
  }: TCommandsListProps) => {
    return (
      <div className="w-80 border-r flex flex-col">
        <div className="px-4 py-3 border-b bg-muted/30">
          <h3 className="font-semibold text-sm">Commands</h3>
        </div>
        <div className="flex-1 overflow-y-auto">
          {availableCommands.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              No commands available for this plugin
            </div>
          ) : (
            <div className="p-2">
              {availableCommands.map((cmd) => (
                <button
                  key={cmd.name}
                  onClick={() => handleCommandChange(cmd.name)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                    'hover:bg-muted',
                    selectedCommand === cmd.name &&
                      'bg-primary text-primary-foreground hover:bg-primary/90'
                  )}
                >
                  <div className="font-medium">{cmd.name}</div>
                  {cmd.description && (
                    <div
                      className={cn(
                        'text-xs mt-1',
                        selectedCommand === cmd.name
                          ? 'text-primary-foreground/70'
                          : 'text-muted-foreground'
                      )}
                    >
                      {cmd.description}
                    </div>
                  )}
                  {cmd.subcommands && cmd.subcommands.length > 0 ? (
                    // The verbs are the command's real surface; the
                    // positional arguments such a command still
                    // declares are its legacy spelling and would only
                    // read as a wrong "N arguments".
                    <ul
                      className={cn(
                        'text-xs mt-1.5 space-y-1',
                        selectedCommand === cmd.name
                          ? 'text-primary-foreground/70'
                          : 'text-muted-foreground'
                      )}
                    >
                      {cmd.subcommands.map((sub) => (
                        <li key={sub.name}>
                          <span className="font-mono">
                            {cmd.name} {sub.name}
                            {sub.args?.map((arg) => (
                              <span key={arg.name}>
                                {' '}
                                {arg.required ? `<${arg.name}>` : `[${arg.name}]`}
                              </span>
                            ))}
                          </span>
                          {sub.description && <> — {sub.description}</>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    cmd.args &&
                    cmd.args.length > 0 && (
                      <div
                        className={cn(
                          'text-xs mt-1',
                          selectedCommand === cmd.name
                            ? 'text-primary-foreground/70'
                            : 'text-muted-foreground'
                        )}
                      >
                        {cmd.args.length} argument
                        {cmd.args.length !== 1 ? 's' : ''}
                      </div>
                    )
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
);

export { CommandsList };
