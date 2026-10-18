import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Group } from '@/components/ui/group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { usePluginsEnabled } from '@/features/server/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TCommandInfo } from '@pulse/shared';
import { Info, Play } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { TDialogBaseProps } from '../types';
import { Args } from './args';
import { CommandsList } from './commands-list';
import { Helpers } from './helpers';
import { Response } from './response';
import type { TCommandResponse } from './types';

export type TPluginCommandsDialogProps = TDialogBaseProps & {
  pluginId: string;
  /**
   * The plugin's commands as `plugins.get` lists them (instance-scoped).
   * The composer's command map is gated on the ACTIVE community's
   * Plugins switch, so this dialog — opened from the instance panel —
   * must not read it: an instance owner looking from a community with
   * Plugins off would see nothing.
   */
  commands: TCommandInfo[];
};

/** The select's value for "no sub-command" (a Select item cannot be ''). */
const NO_SUBCOMMAND = '__none';

const PluginCommandsDialog = memo(
  ({ isOpen, close, pluginId, commands }: TPluginCommandsDialogProps) => {
    const commandsEnabledHere = usePluginsEnabled();
    const [selectedCommand, setSelectedCommand] = useState<string>('');
    // '' runs the command itself (its own arguments, or its usage).
    const [selectedSubcommand, setSelectedSubcommand] = useState<string>('');
    type TCommandArgValue = string | number | boolean | null;
    const [commandArgs, setCommandArgs] = useState<Record<string, TCommandArgValue>>({});
    const [isExecuting, setIsExecuting] = useState(false);
    const [commandResponse, setCommandResponse] =
      useState<TCommandResponse | null>(null);

    const availableCommands = useMemo(() => commands ?? [], [commands]);

    const selectedCommandInfo = useMemo(() => {
      return availableCommands.find((cmd) => cmd.name === selectedCommand);
    }, [availableCommands, selectedCommand]);

    const selectedSubcommandInfo = useMemo(
      () =>
        selectedCommandInfo?.subcommands?.find(
          (sub) => sub.name === selectedSubcommand
        ),
      [selectedCommandInfo, selectedSubcommand]
    );

    /** What the form asks for: the sub-command's arguments once one is chosen. */
    const activeArgs = useMemo(
      () =>
        selectedSubcommandInfo
          ? (selectedSubcommandInfo.args ?? [])
          : (selectedCommandInfo?.args ?? []),
      [selectedCommandInfo, selectedSubcommandInfo]
    );

    const handleCommandChange = useCallback(
      (commandName: string) => {
        setSelectedCommand(commandName);
        // A command that acts through sub-commands opens on its first
        // verb: its own positional arguments (when it keeps any) are
        // the legacy spelling, not what the form should lead with.
        const first = availableCommands.find((cmd) => cmd.name === commandName)
          ?.subcommands?.[0];
        setSelectedSubcommand(first?.name ?? '');
        setCommandArgs({});
        setCommandResponse(null);
      },
      [availableCommands]
    );

    const handleSubcommandChange = useCallback((name: string) => {
      setSelectedSubcommand(name === NO_SUBCOMMAND ? '' : name);
      setCommandArgs({});
      setCommandResponse(null);
    }, []);

    const handleArgChange = useCallback(
      (argName: string, value: string, type: string) => {
        setCommandArgs((prev) => {
          let parsedValue: TCommandArgValue = value;

          if (type === 'number') {
            parsedValue = value === '' ? null : Number(value);
          } else if (type === 'boolean') {
            parsedValue = value === 'true';
          }

          return {
            ...prev,
            [argName]: parsedValue
          };
        });
      },
      []
    );

    const handleExecute = useCallback(async () => {
      if (!pluginId || !selectedCommand) return;

      setIsExecuting(true);
      setCommandResponse(null);

      try {
        const trpc = getTRPCClient();
        if (!trpc) return;

        const response = await trpc.plugins.executeCommand.mutate({
          pluginId,
          commandName: selectedCommand,
          ...(selectedSubcommand ? { subcommand: selectedSubcommand } : {}),
          args: commandArgs
        });

        setCommandResponse({
          success: true,
          data: response
        });

        toast.success(`Command '${selectedCommand}' executed successfully`);
      } catch (error) {
        const errorMessage = getTrpcError(error, 'Failed to execute command');

        setCommandResponse({
          success: false,
          error: errorMessage
        });

        toast.error(errorMessage);
      } finally {
        setIsExecuting(false);
      }
    }, [pluginId, selectedCommand, selectedSubcommand, commandArgs]);

    const canExecute = useMemo(() => {
      if (!selectedCommandInfo) return false;

      for (const arg of activeArgs) {
        if (arg.required && !commandArgs[arg.name]) {
          return false;
        }
      }

      return true;
    }, [selectedCommandInfo, activeArgs, commandArgs]);

    return (
      <Dialog open={isOpen} onOpenChange={close}>
        <DialogContent className="flex flex-col min-w-[calc(90vw/var(--app-zoom))] h-[calc(var(--vvh)*0.85)] p-0 gap-0">
          <DialogHeader className="px-6 py-4 border-b">
            <DialogTitle>Available Commands For {pluginId}</DialogTitle>
          </DialogHeader>

          {!commandsEnabledHere && (
            <div
              className="flex items-center gap-2 px-6 py-2 border-b bg-muted/30 text-xs text-muted-foreground"
              role="note"
            >
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>
                Commands run here once Server Settings → General → Plugins is
                on for this community.
              </span>
            </div>
          )}

          <div className="flex flex-1 overflow-hidden">
            <CommandsList
              availableCommands={availableCommands}
              handleCommandChange={handleCommandChange}
              selectedCommand={selectedCommand}
            />

            <div className="flex-1 flex flex-col overflow-hidden">
              {!selectedCommandInfo ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <Play className="w-16 h-16 mx-auto mb-4 opacity-20" />
                    <p className="text-lg">Select a command to execute</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto p-6">
                    <div className="max-w-2xl">
                      <div className="mb-6">
                        <h2 className="text-xl font-semibold mb-2">
                          {selectedCommandInfo.name}
                        </h2>
                        {selectedCommandInfo.description && (
                          <p className="text-sm text-muted-foreground">
                            {selectedCommandInfo.description}
                          </p>
                        )}
                      </div>

                      {selectedCommandInfo.subcommands &&
                        selectedCommandInfo.subcommands.length > 0 && (
                          <div className="mb-4">
                            <Group
                              label="Sub-command"
                              description={
                                selectedSubcommandInfo?.description ??
                                'What the command should do'
                              }
                            >
                              <Select
                                value={selectedSubcommand || NO_SUBCOMMAND}
                                onValueChange={handleSubcommandChange}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={NO_SUBCOMMAND}>
                                    {selectedCommandInfo.args?.length
                                      ? 'None (the command itself)'
                                      : 'None (show usage)'}
                                  </SelectItem>
                                  {selectedCommandInfo.subcommands.map((sub) => (
                                    <SelectItem key={sub.name} value={sub.name}>
                                      {sub.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Group>
                          </div>
                        )}

                      {activeArgs.length > 0 ? (
                        <Args
                          args={activeArgs}
                          commandArgs={commandArgs}
                          handleArgChange={handleArgChange}
                        />
                      ) : (
                        <div className="p-4 border rounded-lg bg-muted/30">
                          <p className="text-sm text-muted-foreground">
                            {selectedSubcommandInfo
                              ? 'This sub-command takes no arguments.'
                              : 'This command does not require any arguments.'}
                          </p>
                        </div>
                      )}

                      {commandResponse && (
                        <Response response={commandResponse} />
                      )}
                    </div>
                  </div>

                  <div className="border-t p-4 bg-muted/30">
                    <div className="flex justify-start gap-4">
                      <Button variant="outline" onClick={close}>
                        Close
                      </Button>
                      <Button
                        onClick={handleExecute}
                        disabled={
                          !canExecute || isExecuting || !commandsEnabledHere
                        }
                      >
                        <Play className="w-4 h-4 mr-2" />
                        {isExecuting ? 'Executing...' : 'Execute Command'}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <Helpers />
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

PluginCommandsDialog.displayName = 'PluginCommandsDialog';

export { PluginCommandsDialog };
