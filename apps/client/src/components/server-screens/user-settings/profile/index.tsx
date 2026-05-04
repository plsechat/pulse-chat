import Color from '@/components/ui/color';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { Textarea } from '@/components/ui/textarea';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { useForm } from '@/hooks/use-form';
import { getTRPCClient } from '@/lib/trpc';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { AvatarManager } from './avatar-manager';
import { BannerManager } from './banner-manager';

const Profile = memo(() => {
  const ownPublicUser = useOwnPublicUser();
  const { setTrpcErrors, r, rr, values } = useForm({
    name: ownPublicUser?.name ?? '',
    bannerColor: ownPublicUser?.bannerColor ?? '#FFFFFF',
    bio: ownPublicUser?.bio ?? ''
  });

  const onUpdateUser = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.users.update.mutate(values);
      toast.success('Profile updated');
    } catch (error) {
      setTrpcErrors(error);
    }
  }, [values, setTrpcErrors]);

  if (!ownPublicUser) return null;

  return (
    <div className="space-y-4">
        <AvatarManager user={ownPublicUser} />

        <Group label="Display Name">
          <Input placeholder="Display Name" {...r('name')} />
        </Group>

        <Group label="Bio">
          <Textarea placeholder="Tell us about yourself..." {...r('bio')} />
        </Group>

        <Group label="Banner color">
          <Color {...rr('bannerColor')} defaultValue="#FFFFFF" />
        </Group>

        <BannerManager user={ownPublicUser} />

        <SettingsFormFooter
          onCancel={closeServerScreens}
          onSave={onUpdateUser}
        />
    </div>
  );
});

export { Profile };
