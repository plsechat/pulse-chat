import Color from '@/components/ui/color';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { Textarea } from '@/components/ui/textarea';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { useForm } from '@/hooks/use-form';
import { getHomeTRPCClient } from '@/lib/trpc';
import type { TJoinedPublicUser, TNameStyle } from '@pulse/shared';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { AvatarDecorationPicker } from './avatar-decoration-picker';
import { AvatarManager } from './avatar-manager';
import { BannerManager } from './banner-manager';
import { NameplatePicker } from './nameplate-picker';
import { NameStyleEditor } from './name-style-editor';
import { ProfilePreviewCard } from './profile-preview-card';

/** Two-pane profile-cosmetics editor: controls on the left, a sticky
 *  live profile-card preview on the right that overlays PENDING picks
 *  (form values + drafted name style) on the current user. */
const Profiles = memo(() => {
  const ownPublicUser = useOwnPublicUser();
  const { setTrpcErrors, r, rr, values } = useForm({
    bannerColor: ownPublicUser?.bannerColor ?? '#FFFFFF',
    bio: ownPublicUser?.bio ?? '',
    pronouns: ownPublicUser?.pronouns ?? ''
  });
  // undefined = no pending name-style draft — preview follows the store.
  const [draftNameStyle, setDraftNameStyle] = useState<TNameStyle | undefined>(
    undefined
  );

  const onUpdateUser = useCallback(async () => {
    const trpc = getHomeTRPCClient();
    if (!trpc || !ownPublicUser) return;

    try {
      // users.update always writes the full profile row — the display
      // name stays owned by My Account, so resend it unchanged.
      await trpc.users.update.mutate({ name: ownPublicUser.name, ...values });
      toast.success('Profile updated');
    } catch (error) {
      setTrpcErrors(error);
    }
  }, [values, ownPublicUser, setTrpcErrors]);

  if (!ownPublicUser) return null;

  const previewUser: TJoinedPublicUser = {
    ...ownPublicUser,
    bannerColor: values.bannerColor,
    bio: values.bio || null,
    pronouns: values.pronouns || null,
    nameStyle:
      draftNameStyle === undefined ? ownPublicUser.nameStyle : draftNameStyle
  };

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 space-y-4">
        <AvatarManager user={ownPublicUser} />

        <Group
          label="Avatar Decoration"
          description="An animated frame shown around your avatar."
        >
          <AvatarDecorationPicker user={ownPublicUser} />
        </Group>

        <Group label="Banner color">
          <Color {...rr('bannerColor')} defaultValue="#FFFFFF" />
        </Group>

        <BannerManager user={ownPublicUser} />

        <Group label="Pronouns">
          <Input placeholder="e.g. she/her" maxLength={40} {...r('pronouns')} />
        </Group>

        <Group label="Bio">
          <Textarea placeholder="Tell us about yourself..." {...r('bio')} />
        </Group>

        <Group
          label="Nameplate"
          description="A decorative background shown behind your name in member lists."
        >
          <NameplatePicker user={ownPublicUser} />
        </Group>

        <Group
          label="Display Name Style"
          description="Styles your name on home surfaces — DMs and friends. Server chat keeps role colors."
        >
          <NameStyleEditor
            user={ownPublicUser}
            onDraftChange={setDraftNameStyle}
          />
        </Group>

        <SettingsFormFooter
          onCancel={closeServerScreens}
          onSave={onUpdateUser}
        />
      </div>

      <div className="w-full shrink-0 lg:sticky lg:top-0 lg:w-80">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Preview
        </p>
        <ProfilePreviewCard user={previewUser} />
      </div>
    </div>
  );
});

export { Profiles };
