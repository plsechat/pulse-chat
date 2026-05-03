import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useAdminChannelGeneral } from '@/features/server/admin/hooks';
import { SLOW_MODE_LABELS, SLOW_MODE_OPTIONS } from '@pulse/shared';
import { memo } from 'react';

type TGeneralProps = {
  channelId: number;
};

const General = memo(({ channelId }: TGeneralProps) => {
  const { channel, loading, onChange, submit, errors } =
    useAdminChannelGeneral(channelId);

  if (!channel) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel Information</CardTitle>
        <CardDescription>
          Manage your channel's basic information
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Group label="Name">
          <Input
            value={channel.name}
            onChange={(e) => onChange('name', e.target.value)}
            placeholder="Enter server name"
            error={errors.name}
          />
        </Group>

        <Group label="Topic">
          <Textarea
            value={channel.topic ?? ''}
            onChange={(e) => onChange('topic', e.target.value || null)}
            placeholder="Enter channel topic"
          />
        </Group>

        <Group
          label="Private"
          description="Restricts access to this channel to specific roles and members."
        >
          <Switch
            checked={channel.private}
            onCheckedChange={(value) => onChange('private', value)}
          />
        </Group>

        <Group
          label="Slow Mode"
          description="Limit how often users can send messages in this channel."
        >
          <Select
            value={String(channel.slowMode ?? 0)}
            onValueChange={(value) => onChange('slowMode', Number(value))}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SLOW_MODE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {SLOW_MODE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Group>

        <SettingsFormFooter
          onCancel={closeServerScreens}
          onSave={submit}
          saving={loading}
        />
      </CardContent>
    </Card>
  );
});

export { General };
