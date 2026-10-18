import { Input } from '@/components/ui/input';

type TSecretSettingFieldProps = {
  id: string;
  isSet: boolean;
  draft: string;
  onChange: (value: string) => void;
};

/**
 * A `secret` plugin setting in the settings panel. The server never
 * returns the value — the route only says whether one is set — so the
 * field is write-only: a masked input that sets a value where there is
 * none, or replaces the one there is. Nothing typed here comes back
 * once saved.
 */
const SecretSettingField = ({
  id,
  isSet,
  draft,
  onChange
}: TSecretSettingFieldProps) => (
  <div className="space-y-2">
    <p className="text-sm text-muted-foreground" role="status">
      {isSet
        ? 'A value is set. It is stored encrypted and never shown here; enter a new one to replace it.'
        : 'No value is set yet.'}
    </p>
    <Input
      id={id}
      type="password"
      autoComplete="new-password"
      spellCheck={false}
      value={draft}
      onChange={(e) => onChange(e.target.value)}
      placeholder={isSet ? 'New value' : 'Value'}
      className="max-w-md"
    />
  </div>
);

export { SecretSettingField };
