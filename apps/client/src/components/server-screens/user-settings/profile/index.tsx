import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { SettingsFormFooter } from '@/components/ui/settings-form-footer';
import { closeServerScreens } from '@/features/server-screens/actions';
import { disconnectFromServer } from '@/features/server/actions';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useForm } from '@/hooks/use-form';
import { getHomeTRPCClient } from '@/lib/trpc';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const PROVIDER_LABELS: Record<string, string> = {
  email: 'Email & password',
  oidc: 'Single sign-on (OIDC)',
  google: 'Google',
  discord: 'Discord',
  facebook: 'Facebook',
  twitch: 'Twitch'
};

/** Danger-zone dialog: type the display name (and the password, for
 *  password accounts) to permanently delete the account. */
const DeleteAccountDialog = memo(
  ({
    open,
    onOpenChange,
    accountName,
    hasPasswordAuth
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    accountName: string;
    hasPasswordAuth: boolean;
  }) => {
    const [confirmName, setConfirmName] = useState('');
    const [password, setPassword] = useState('');
    const [deleting, setDeleting] = useState(false);

    const onDelete = useCallback(async () => {
      const trpc = getHomeTRPCClient();
      if (!trpc) return;

      setDeleting(true);
      try {
        await trpc.users.deleteAccount.mutate({
          confirmName,
          password: password || undefined
        });
        toast.success('Your account has been deleted');
        // Full local teardown — session, E2EE keys, stores — then the
        // connect screen. The server also closes our sockets shortly.
        disconnectFromServer();
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to delete account'));
        setDeleting(false);
      }
    }, [confirmName, password]);

    const confirmMatches = confirmName === accountName;
    const passwordOk = !hasPasswordAuth || password.length > 0;

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete account</DialogTitle>
            <DialogDescription>
              This permanently deletes your account. Your messages remain
              visible, authored by an anonymous &quot;Deleted User&quot;;
              your profile, friendships, and server memberships are erased.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Type <span className="text-foreground">{accountName}</span> to
                confirm
              </span>
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={accountName}
                autoComplete="off"
              />
            </div>

            {hasPasswordAuth && (
              <div className="space-y-1.5">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Password
                </span>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Current password"
                  autoComplete="current-password"
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={deleting || !confirmMatches || !passwordOk}
            >
              {deleting ? 'Deleting…' : 'Delete account forever'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

/** Change-password form — password accounts only (folded in from the
 *  old standalone Password tab). */
const ChangePassword = memo(() => {
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
        saveLabel="Update Password"
      />
    </div>
  );
});

/** My Account = who you are and how you sign in: account info (email,
 *  sign-in method), display name, password management, and the danger
 *  zone. Cosmetics live in Personalization. */
const Profile = memo(() => {
  const ownPublicUser = useOwnPublicUser();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [authInfo, setAuthInfo] = useState<{
    providers: string[];
    email: string | null;
  } | null>(null);
  const { setTrpcErrors, r, values } = useForm({
    name: ownPublicUser?.name ?? ''
  });

  useEffect(() => {
    let cancelled = false;
    const trpc = getHomeTRPCClient();
    if (!trpc) return;
    trpc.users.getAuthProviders
      .query()
      .then((res) => {
        if (!cancelled) {
          setAuthInfo({ providers: res.providers, email: res.email ?? null });
        }
      })
      .catch(() => {
        // Fall back to assuming a password account — the server stays
        // the authoritative gate for anything that matters.
        if (!cancelled) setAuthInfo({ providers: ['email'], email: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onUpdateUser = useCallback(async () => {
    const trpc = getHomeTRPCClient();
    if (!trpc || !ownPublicUser) return;

    try {
      // users.update always writes the full profile row — resend the
      // cosmetic fields (owned by the Personalization tab) unchanged.
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

  const hasPasswordAuth = authInfo?.providers.includes('email') ?? false;
  const signInMethods = authInfo
    ? authInfo.providers
        .map((p) => PROVIDER_LABELS[p] ?? p)
        .join(', ')
    : '…';

  return (
    <div className="space-y-4">
      {/* Account info — read-only identity facts */}
      <div className="rounded-lg border border-border p-4 space-y-2">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            Email
          </span>
          <span className="text-sm text-foreground truncate">
            {authInfo === null ? '…' : (authInfo.email ?? 'Managed by your identity provider')}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            Sign-in method
          </span>
          <span className="text-sm text-foreground">{signInMethods}</span>
        </div>
      </div>

      <Group label="Display Name">
        <Input placeholder="Display Name" {...r('name')} />
      </Group>

      <SettingsFormFooter
        onCancel={closeServerScreens}
        onSave={onUpdateUser}
      />

      {hasPasswordAuth && (
        <div className="mt-8 space-y-4">
          <div>
            <h3 className="text-lg font-semibold">Password</h3>
            <p className="text-sm text-muted-foreground">
              Change the password you sign in with.
            </p>
          </div>
          <ChangePassword />
        </div>
      )}

      <div className="mt-8 rounded-lg border border-destructive/40 p-4">
        <h4 className="text-sm font-semibold text-destructive">
          Danger zone
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Permanently delete your account. Messages you sent stay visible as
          an anonymous &quot;Deleted User&quot;; everything else about you is
          erased. If you own servers, transfer or delete them first.
        </p>
        <Button
          variant="destructive"
          size="sm"
          className="mt-3"
          onClick={() => setDeleteOpen(true)}
        >
          Delete Account
        </Button>
      </div>

      <DeleteAccountDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        accountName={ownPublicUser.name}
        hasPasswordAuth={hasPasswordAuth}
      />
    </div>
  );
});

export { Profile };
