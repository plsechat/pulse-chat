import { requestConfirmation } from '@/features/dialogs/actions';
import type { IRootState } from '@/features/store';
import { parseTrpcErrors, type TTrpcErrors } from '@/helpers/parse-trpc-errors';
import { useForm } from '@/hooks/use-form';
import { getTRPCClient } from '@/lib/trpc';
import {
  Permission,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MAX_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA,
  StorageOverflowAction,
  type TCategory,
  type TChannel,
  type TChannelRolePermission,
  type TChannelUserPermission,
  type TDiskMetrics,
  type TFile,
  type TJoinedEmoji,
  type TJoinedInvite,
  type TJoinedRole,
  type TJoinedUser,
  type TLogin,
  type TMessage,
  type TPluginInfo,
  type TRole,
  type TStorageSettings
} from '@pulse/shared';
import { filesize } from 'filesize';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { useCan } from '../hooks';

/**
 * Calls `refetch` whenever the watched Redux selector value changes,
 * skipping the initial mount.
 */
function useSubscriptionRefetch<T>(
  selector: (state: IRootState) => T,
  refetch: () => void
) {
  const value = useSelector(selector);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}

// TODO: review this whole file for optimizations and improvements

export const useAdminGeneral = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [settings, setSettings] = useState({
    name: '',
    description: '',
    password: '',
    allowNewUsers: false,
    enablePlugins: false,
    discoverable: false,
    federatable: false
  });
  const [logo, setLogo] = useState<TFile | null>(null);

  const fetchSettings = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    const result = await trpc.others.getSettings.query({ serverId });

    setSettings({
      name: result.name,
      description: result.description ?? '',
      password: result.password ?? '',
      allowNewUsers: result.allowNewUsers ?? false,
      enablePlugins: result.enablePlugins ?? false,
      discoverable: result.discoverable ?? false,
      federatable: result.federatable ?? false
    });
    setLoading(false);
    setLogo(result.logo);
  }, [serverId]);

  const submit = useCallback(async () => {
    if (!serverId) return;
    const trpc = getTRPCClient();

    try {
      await trpc.others.updateSettings.mutate({
        serverId,
        name: settings.name,
        description: settings.description,
        password: settings.password || undefined,
        allowNewUsers: settings.allowNewUsers,
        enablePlugins: settings.enablePlugins,
        discoverable: settings.discoverable,
        federatable: settings.federatable
      });
      toast.success('Settings updated');
    } catch (error) {
      console.error('Error updating settings:', error);
      setErrors(parseTrpcErrors(error));
    }
  }, [settings, serverId]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChange = useCallback((field: keyof typeof settings, value: any) => {
    setSettings((s) => ({ ...s, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useSubscriptionRefetch((s) => s.server.publicSettings, fetchSettings);

  return {
    settings,
    refetch: fetchSettings,
    loading,
    submit,
    errors,
    onChange,
    logo
  };
};

export const useAdminUpdates = () => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [hasUpdate, setHasUpdate] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [canUpdate, setCanUpdate] = useState(false);

  const fetchUpdate = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();

    try {
      const { hasUpdate, latestVersion, canUpdate, currentVersion } =
        await trpc.others.getUpdate.query();

      setHasUpdate(hasUpdate);
      setLatestVersion(latestVersion);
      setCurrentVersion(currentVersion);
      setCanUpdate(canUpdate);
    } catch (error) {
      console.error('Error fetching update:', error);
      setErrors(parseTrpcErrors(error));
    }

    setLoading(false);
  }, []);

  const update = useCallback(async () => {
    const answer = await requestConfirmation({
      title: 'Are you sure you want to update the server?',
      message:
        'This will download and install the latest version of the server. The server will be restarted during the process, which may cause temporary downtime.',
      confirmLabel: 'Update',
      cancelLabel: 'Cancel'
    });

    if (!answer) return;

    const trpc = getTRPCClient();

    try {
      trpc.others.updateServer.mutate();

      toast.success('Server update initiated');
    } catch (error) {
      console.error('Error updating server:', error);
      setErrors(parseTrpcErrors(error));
    }
  }, []);

  useEffect(() => {
    fetchUpdate();
  }, [fetchUpdate]);

  return {
    refetch: fetchUpdate,
    loading,
    hasUpdate,
    latestVersion,
    currentVersion,
    canUpdate,
    errors,
    update
  };
};

export const useAdminPlugins = () => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [plugins, setPlugins] = useState<TPluginInfo[]>([]);

  const fetchPlugins = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();

    try {
      const { plugins } = await trpc.plugins.get.query();

      // TODO: check this
      // @ts-expect-error - ver esta merda wtf
      setPlugins(plugins);
    } catch (error) {
      console.error('Error fetching plugins:', error);
      setErrors(parseTrpcErrors(error));
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  return {
    refetch: fetchPlugins,
    plugins,
    loading,
    errors
  };
};

export const useHasUpdates = () => {
  const can = useCan();
  const [hasUpdates, setHasUpdates] = useState(false);

  const fetchHasUpdates = useCallback(async () => {
    if (!can(Permission.MANAGE_UPDATES)) return;

    const trpc = getTRPCClient();

    try {
      const { hasUpdate } = await trpc.others.getUpdate.query();

      setHasUpdates(hasUpdate);
    } catch (error) {
      console.error('Error fetching update status:', error);
    }
  }, [can]);

  useEffect(() => {
    fetchHasUpdates();
  }, [fetchHasUpdates]);

  return hasUpdates;
};

export const useAdminChannelGeneral = (channelId: number) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [channel, setChannel] = useState<TChannel | undefined>(undefined);

  const fetchChannel = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const channel = await trpc.channels.get.query({ channelId });

    setChannel(channel);
    setLoading(false);
  }, [channelId]);

  const submit = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.channels.update.mutate({
        channelId,
        name: channel?.name ?? '',
        topic: channel?.topic ?? null,
        private: channel?.private ?? false,
        slowMode: channel?.slowMode ?? 0
      });

      toast.success('Channel updated');
    } catch (error) {
      console.error('Error updating channel:', error);
      setErrors(parseTrpcErrors(error));
    }
  }, [channel, channelId]);

  const onChange = useCallback(
    (field: keyof TChannel, value: string | null | boolean | number) => {
      if (!channel) return;
      setChannel((c) => (c ? { ...c, [field]: value } : c));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    [channel]
  );

  useEffect(() => {
    fetchChannel();
  }, [fetchChannel]);

  useSubscriptionRefetch((s) => s.server.channels, fetchChannel);

  return {
    channel,
    refetch: fetchChannel,
    loading,
    errors,
    onChange,
    submit
  };
};

export const useAdminCategoryGeneral = (categoryId: number) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [category, setCategory] = useState<TCategory | undefined>(undefined);

  const fetchCategory = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const category = await trpc.categories.get.query({ categoryId });

    setCategory(category);
    setLoading(false);
  }, [categoryId]);

  const submit = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.categories.update.mutate({
        categoryId,
        name: category?.name ?? ''
      });

      toast.success('Category updated');
    } catch (error) {
      console.error('Error updating category:', error);
      setErrors(parseTrpcErrors(error));
    }
  }, [category, categoryId]);

  const onChange = useCallback(
    (field: keyof TCategory, value: string | null) => {
      if (!category) return;
      setCategory((c) => (c ? { ...c, [field]: value } : c));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    [category]
  );

  useEffect(() => {
    fetchCategory();
  }, [fetchCategory]);

  useSubscriptionRefetch((s) => s.server.categories, fetchCategory);

  return {
    category,
    refetch: fetchCategory,
    loading,
    errors,
    onChange,
    submit
  };
};

export const useAdminEmojis = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [emojis, setEmojis] = useState<TJoinedEmoji[]>([]);

  const fetchEmojis = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    const emojis = await trpc.emojis.getAll.query({ serverId });

    setEmojis(emojis);
    setLoading(false);
  }, [serverId]);

  const onChange = useCallback(
    (field: keyof TJoinedEmoji, value: string | null) => {
      if (!emojis) return;

      setEmojis((c) => (c ? { ...c, [field]: value } : c));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    [emojis]
  );

  useEffect(() => {
    fetchEmojis();
  }, [fetchEmojis]);

  useSubscriptionRefetch((s) => s.server.emojis, fetchEmojis);

  return {
    emojis,
    refetch: fetchEmojis,
    loading,
    errors,
    onChange
  };
};

export const useAdminRoles = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [roles, setRoles] = useState<TJoinedRole[]>([]);

  const fetchRoles = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    const roles = await trpc.roles.getAll.query({ serverId });

    setRoles(roles);
    setLoading(false);
  }, [serverId]);

  const onChange = useCallback(
    (field: keyof TRole, value: string | null) => {
      if (!roles) return;

      setRoles((c) => (c ? { ...c, [field]: value } : c));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    [roles]
  );

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  useSubscriptionRefetch((s) => s.server.roles, fetchRoles);

  return {
    roles,
    refetch: fetchRoles,
    loading,
    errors,
    onChange
  };
};

export const useAdminStorage = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const { values, setValues, setTrpcErrors, r, onChange } =
    useForm<TStorageSettings>({
      storageOverflowAction: STORAGE_OVERFLOW_ACTION,
      storageSpaceQuotaByUser: STORAGE_MAX_QUOTA_PER_USER,
      storageUploadEnabled: true,
      storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
      storageQuota: STORAGE_QUOTA
    });
  const [diskMetrics, setDiskMetrics] = useState<TDiskMetrics | undefined>(
    undefined
  );

  const fetchStorageSettings = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    const { storageSettings, diskMetrics } =
      await trpc.others.getStorageSettings.query({ serverId });

    setValues(storageSettings);
    setDiskMetrics(diskMetrics);
    setLoading(false);
  }, [setValues, serverId]);

  const submit = useCallback(async () => {
    if (!serverId) return;
    const trpc = getTRPCClient();

    try {
      await trpc.others.updateSettings.mutate({
        serverId,
        storageUploadEnabled: values.storageUploadEnabled,
        storageUploadMaxFileSize: values.storageUploadMaxFileSize,
        storageSpaceQuotaByUser: values.storageSpaceQuotaByUser,
        storageOverflowAction:
          values.storageOverflowAction as StorageOverflowAction
      });
      toast.success('Storage settings updated');
    } catch (error) {
      console.error('Error updating storage settings:', error);
      setTrpcErrors(error);
    }
  }, [values, setTrpcErrors, serverId]);

  const labels = useMemo(() => {
    return {
      storageUploadMaxFileSize: filesize(
        Number(values.storageUploadMaxFileSize ?? 0),
        {
          output: 'object',
          standard: 'jedec'
        }
      ),
      storageSpaceQuotaByUser: filesize(
        Number(values.storageSpaceQuotaByUser ?? 0),
        {
          output: 'object',
          standard: 'jedec'
        }
      ),
      storageQuota: filesize(Number(values.storageQuota ?? 0), {
        output: 'object',
        standard: 'jedec'
      })
    };
  }, [values]);

  useEffect(() => {
    fetchStorageSettings();
  }, [fetchStorageSettings]);

  useSubscriptionRefetch((s) => s.server.publicSettings, fetchStorageSettings);

  return {
    values,
    labels,
    refetch: fetchStorageSettings,
    loading,
    submit,
    r,
    onChange,
    diskMetrics
  };
};

export const useAdminUsers = () => {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<TJoinedUser[]>([]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const users = await trpc.users.getAll.query();

    setUsers(users);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useSubscriptionRefetch((s) => s.server.users, fetchUsers);

  return {
    users,
    refetch: fetchUsers,
    loading
  };
};

export const useAdminChannelPermissions = (channelId: number) => {
  const [loading, setLoading] = useState(true);
  const [rolePermissions, setRolePermissions] = useState<
    TChannelRolePermission[]
  >([]);
  const [userPermissions, setUserPermissions] = useState<
    TChannelUserPermission[]
  >([]);

  const fetchPermissions = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const { rolePermissions, userPermissions } =
      await trpc.channels.getPermissions.mutate({ channelId });

    setRolePermissions(rolePermissions);
    setUserPermissions(userPermissions);
    setLoading(false);
  }, [channelId]);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  useSubscriptionRefetch((s) => s.server.channelPermissions, fetchPermissions);

  return {
    rolePermissions,
    userPermissions,
    refetch: fetchPermissions,
    loading
  };
};

export const useAdminUserInfo = (userId: number) => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<TJoinedUser | null>(null);
  const [logins, setLogins] = useState<TLogin[]>([]);
  const [files, setFiles] = useState<TFile[]>([]);
  const [messages, setMessages] = useState<TMessage[]>([]);

  const fetchUser = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    const { user, logins, files, messages } = await trpc.users.getInfo.query({
      userId
    });

    setUser(user);
    setLoading(false);
    setLogins(logins);
    setFiles(files);
    setMessages(messages);
  }, [userId]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return {
    user,
    logins,
    files,
    refetch: fetchUser,
    loading,
    messages
  };
};

export const useAdminInvites = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const [invites, setInvites] = useState<TJoinedInvite[]>([]);

  const fetchInvites = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    const invites = await trpc.invites.getAll.query({ serverId });

    setInvites(invites);
    setLoading(false);
  }, [serverId]);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  // Refetch when invite events arrive
  useEffect(() => {
    const handler = () => { fetchInvites(); };
    window.addEventListener('invites-changed', handler);
    return () => window.removeEventListener('invites-changed', handler);
  }, [fetchInvites]);

  return {
    invites,
    refetch: fetchInvites,
    loading
  };
};
