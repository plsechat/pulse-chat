import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { useForm } from '@/hooks/use-form';
import { getHomeTRPCClient } from '@/lib/trpc';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

/** Identity/account concerns only — profile cosmetics (avatar, banner,
 *  bio, pronouns, nameplate, decoration, name style) live in Profiles. */
const Profile = memo(() => {
  const ownPublicUser = useOwnPublicUser();
  const { setTrpcErrors, r, values } = useForm({
    name: ownPublicUser?.name ?? ''
  });

  const onUpdateUser = useCallback(async () => {
    const trpc = getHomeTRPCClient();
    if (!trpc || !ownPublicUser) return;

    try {
      // users.update always writes the full profile row — resend the
      // cosmetic fields (owned by the Profiles tab) unchanged.
      await trpc.users.update.mutate({
        name: values.name,
        bannerColor: ownPublicUser.bannerColor ?? '#FFFFFF',
        bio: ownPublicUser.bio ?? '',
        pronouns: ownPublicUser.pronouns
      });
      toast.success('Profile updated');
    } catch (error) {
      setTrpcErrors(error);
    }
  }, [values, ownPublicUser, setTrpcErrors]);

  if (!ownPublicUser) return null;

  return (
    <div className="space-y-4">
      <Group label="Display Name">
        <Input placeholder="Display Name" {...r('name')} />
      </Group>

      <SettingsFormFooter
        onCancel={closeServerScreens}
        onSave={onUpdateUser}
      />
    </div>
  );
});

export { Profile };
