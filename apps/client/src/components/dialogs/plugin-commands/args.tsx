import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import type { TCommandArg } from '@pulse/shared';
import { memo } from 'react';

type TArgsProps = {
  /** The command's own arguments, or the chosen sub-command's. */
  args: TCommandArg[];
  commandArgs: Record<string, unknown>;
  handleArgChange: (argName: string, value: string, type: string) => void;
};

const Args = memo(
  ({ args, commandArgs, handleArgChange }: TArgsProps) => {
    return (
      <div className="space-y-4">
        {args.map((arg) => (
          <Group
            key={arg.name}
            label={arg.name}
            description={`(${arg.type}) ${arg.description ?? ''}`}
            required={arg.required}
          >
            {arg.choices && arg.choices.length > 0 ? (
              <Select
                value={
                  commandArgs[arg.name] !== undefined
                    ? String(commandArgs[arg.name])
                    : ''
                }
                onValueChange={(value) =>
                  handleArgChange(arg.name, value, arg.type)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={arg.placeholder ?? 'Choose…'} />
                </SelectTrigger>
                <SelectContent>
                  {arg.choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label ?? choice.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : arg.type === 'boolean' ? (
              <Select
                value={
                  commandArgs[arg.name] !== undefined
                    ? String(commandArgs[arg.name])
                    : ''
                }
                onValueChange={(value) =>
                  handleArgChange(arg.name, value, arg.type)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select value..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">True</SelectItem>
                  <SelectItem value="false">False</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                type={arg.type === 'number' ? 'number' : 'text'}
                value={
                  commandArgs[arg.name] !== undefined
                    ? String(commandArgs[arg.name])
                    : ''
                }
                onChange={(e) =>
                  handleArgChange(arg.name, e.target.value, arg.type)
                }
                placeholder={arg.placeholder ?? `Enter ${arg.name}...`}
              />
            )}
          </Group>
        ))}
      </div>
    );
  }
);

export { Args };
