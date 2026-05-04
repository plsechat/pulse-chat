import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useForm } from '@/hooks/use-form';
import { getHomeTRPCClient } from '@/lib/trpc';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

const Password = memo(() => {
  const { setTrpcErrors, r, values } = useForm({
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: ''
  });

  const updatePassword = useCallback(async () => {
    const trpc = getHomeTRPCClient();
    if (!trpc) return;

    try {
      await trpc.users.updatePassword.mutate(values);
      toast.success('Password updated!');
    } catch (error) {
      setTrpcErrors(error);
    }
  }, [values, setTrpcErrors]);

  return (
    <div className="space-y-4">
        <Group label="Current Password">
          <Input {...r('currentPassword', 'password')} />
        </Group>

        <Group label="New Password">
          <Input {...r('newPassword', 'password')} />
        </Group>

        <Group label="Confirm New Password">
          <Input {...r('confirmNewPassword', 'password')} />
        </Group>

        <SettingsFormFooter
          onCancel={closeServerScreens}
          onSave={updatePassword}
        />
    </div>
  );
});

export { Password };
