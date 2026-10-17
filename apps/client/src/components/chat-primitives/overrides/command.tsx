import { type TParsedDomCommand } from '@pulse/shared';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
  XCircle
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';

type TCommandOverrideProps = {
  command: TParsedDomCommand;
};

// A short reply is worth reading without a click; a long one (a log, a
// listing) stays folded so the line does not swallow the channel.
const SHORT_RESPONSE_CHARS = 200;

/** An argument as it was typed: quoted when it holds a space. */
const formatValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /\s/.test(text) ? `"${text}"` : text;
};

const STATUS_TEXT = {
  pending: 'Running',
  completed: 'Completed',
  failed: 'Failed'
} as const;

/**
 * A member's command, as the line it is rather than a message: "used
 * /watch pause" in small muted type with the plugin's logo and the
 * outcome, the reply underneath when there is one. What the server
 * stores is unchanged; this is how the stored element reads.
 */
const CommandOverride = memo(({ command }: TCommandOverrideProps) => {
  const response = command.response ?? '';
  const [isExpanded, setIsExpanded] = useState(
    () => response.length <= SHORT_RESPONSE_CHARS
  );
  const failed = command.status === 'failed';

  const invocation = useMemo(
    () =>
      [
        `/${command.commandName}`,
        ...(command.subcommand ? [command.subcommand] : []),
        ...command.args.map((arg) => formatValue(arg.value)).filter(Boolean)
      ].join(' '),
    [command.commandName, command.subcommand, command.args]
  );

  const statusIcon =
    command.status === 'completed' ? (
      <CheckCircle2 className="size-3 text-green-500" aria-hidden="true" />
    ) : command.status === 'failed' ? (
      <XCircle className="size-3 text-destructive" aria-hidden="true" />
    ) : (
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
    );

  return (
    <div
      data-testid="command-line"
      data-status={command.status}
      className="flex min-w-0 flex-col gap-0.5 py-0.5 text-xs text-muted-foreground"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {command.logo ? (
            <img
              src={command.logo}
              alt=""
              className="size-4 rounded-sm object-cover"
            />
          ) : (
            <Terminal className="size-3.5" aria-hidden="true" />
          )}
        </span>
        <span className="shrink-0">used</span>{' '}
        <span className="truncate font-mono text-foreground/85" title={invocation}>
          {invocation}
        </span>
        <span className="flex shrink-0 items-center" title={STATUS_TEXT[command.status]}>
          {statusIcon}
          <span className="sr-only">{STATUS_TEXT[command.status]}</span>
        </span>
      </div>

      {/* The reason a command did not run is the one thing the line must
          say out loud; it never hides behind the fold. */}
      {failed && response && (
        <p
          role="alert"
          className="flex items-start gap-1.5 pl-[1.375rem] text-destructive"
        >
          <XCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{response}</span>
        </p>
      )}

      {!failed && response && (
        <div className="flex min-w-0 flex-col pl-[1.375rem]">
          {response.length > SHORT_RESPONSE_CHARS && (
            <button
              type="button"
              onClick={() => setIsExpanded((open) => !open)}
              aria-expanded={isExpanded}
              className="flex w-fit items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {isExpanded ? (
                <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              )}
              {isExpanded ? 'Hide reply' : 'Show reply'}
            </button>
          )}
          {isExpanded && (
            <pre className="whitespace-pre-wrap break-words font-sans text-foreground/85">
              {response}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

export { CommandOverride };
