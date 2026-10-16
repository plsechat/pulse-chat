import type { IRootState } from '@/features/store';
import {
  getTrpcError,
  parseTrpcErrors,
  type TTrpcErrors
} from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import {
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MAX_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  StorageOverflowAction
} from '@pulse/shared';
import type {
  TCategory,
  TChannel,
  TChannelRolePermission,
  TChannelUserPermission,
  TFile,
  TJoinedEmoji,
  TJoinedInvite,
  TJoinedRole,
  TJoinedUser,
  TLogin,
  TMessage
} from '@pulse/server/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { onAppEvent } from '@/lib/events';

/**
 * Calls `refetch` whenever the watched Redux selector value changes,
 * skipping the initial mount. `refetch` is read through a ref so a new
 * callback identity never triggers a fetch on its own — only `value` does.
 */
function useSubscriptionRefetch<T>(
  selector: (state: IRootState) => T,
  refetch: () => void
) {
  const value = useSelector(selector);
  const mounted = useRef(false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    refetchRef.current();
  }, [value]);
}

export type TAdminQuery<T> = {
  data: T | null;
  loading: boolean;
  /** Message of the last failed fetch; cleared by the next `refetch`. */
  error: string | null;
  refetch: () => Promise<void>;
};

/**
 * One fetch state machine for the read-mostly instance panels: `fn` runs
 * on mount and on every `refetch`, the panel renders a loading card
 * while the first fetch is in flight and an error row (with Retry) when
 * it rejects — instead of staying blank forever. A response that lands
 * after the component unmounted or after a newer fetch started is
 * dropped, so a slow first request can never overwrite a Retry.
 *
 * `fn` must be referentially stable (wrap it in useCallback): a new
 * identity re-fetches.
 */
export const useAdminQuery = <T>(
  fn: () => Promise<T>,
  fallbackError = 'Could not load this section'
): TAdminQuery<T> => {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refetch = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (id !== seq.current) return;
      setData(result);
    } catch (err) {
      if (id !== seq.current) return;
      setError(getTrpcError(err, fallbackError));
    }
    if (id === seq.current) setLoading(false);
  }, [fn, fallbackError]);

  // A changed `fn` re-fetches; the sequence guard above drops whatever
  // the previous call still returns.
  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
};

type TGeneralSettings = {
  name: string;
  description: string;
  password: string;
  allowNewUsers: boolean;
  enablePlugins: boolean;
  discoverable: boolean;
  federatable: boolean;
  storageUploadEnabled: boolean;
  storageUploadMaxFileSize: number;
  storageSpaceQuotaByUser: number;
  storageOverflowAction: StorageOverflowAction;
};

export const useAdminGeneral = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [settings, setSettings] = useState<TGeneralSettings>({
    name: '',
    description: '',
    password: '',
    allowNewUsers: false,
    enablePlugins: false,
    discoverable: false,
    federatable: false,
    storageUploadEnabled: true,
    storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
    storageSpaceQuotaByUser: STORAGE_MAX_QUOTA_PER_USER,
    storageOverflowAction: STORAGE_OVERFLOW_ACTION
  });
  const [logo, setLogo] = useState<TFile | null>(null);

  const fetchSettings = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;
    const result = await trpc.others.getSettings.query({ serverId });

    setSettings({
      name: result.name,
      description: result.description ?? '',
      password: result.password ?? '',
      allowNewUsers: result.allowNewUsers ?? false,
      enablePlugins: result.enablePlugins ?? false,
      discoverable: result.discoverable ?? false,
      federatable: result.federatable ?? false,
      storageUploadEnabled: result.storageUploadEnabled ?? true,
      storageUploadMaxFileSize:
        result.storageUploadMaxFileSize ?? STORAGE_MAX_FILE_SIZE,
      storageSpaceQuotaByUser:
        result.storageSpaceQuotaByUser ?? STORAGE_MAX_QUOTA_PER_USER,
      storageOverflowAction:
        (result.storageOverflowAction as StorageOverflowAction | null) ??
        STORAGE_OVERFLOW_ACTION
    });
    setLoading(false);
    setLogo(result.logo);
  }, [serverId]);

  const submit = useCallback(async () => {
    if (!serverId) return;
    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.others.updateSettings.mutate({
        serverId,
        name: settings.name,
        description: settings.description,
        password: settings.password || undefined,
        allowNewUsers: settings.allowNewUsers,
        enablePlugins: settings.enablePlugins,
        discoverable: settings.discoverable,
        federatable: settings.federatable,
        storageUploadEnabled: settings.storageUploadEnabled,
        storageUploadMaxFileSize: settings.storageUploadMaxFileSize,
        storageSpaceQuotaByUser: settings.storageSpaceQuotaByUser,
        storageOverflowAction: settings.storageOverflowAction
      });
      toast.success('Settings updated');
    } catch (error) {
      console.error('Error updating settings:', error);
      setErrors(parseTrpcErrors(error));
    }
  }, [settings, serverId]);

  const onChange = useCallback(
    <K extends keyof TGeneralSettings>(field: K, value: TGeneralSettings[K]) => {
      setSettings((s) => ({ ...s, [field]: value }));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    []
  );

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

/**
 * Plugin row as the `plugins.get` route actually returns it (`logo` /
 * `homepage` are optional on the wire, matching the package.json
 * schema they come from).
 */
export type TAdminPlugin = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof getTRPCClient>>['plugins']['get']['query']
  >
>['plugins'][number];

/** Instance-wide plugin list (`plugins.get` is instance-owner only). */
export const useAdminPlugins = () => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [plugins, setPlugins] = useState<TAdminPlugin[]>([]);

  const fetchPlugins = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      const { plugins } = await trpc.plugins.get.query();

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

export const useAdminChannelGeneral = (channelId: number) => {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<TTrpcErrors>({});
  const [channel, setChannel] = useState<TChannel | undefined>(undefined);

  const fetchChannel = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;
    const channel = await trpc.channels.get.query({ channelId });

    setChannel(channel);
    setLoading(false);
  }, [channelId]);

  const submit = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

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
    if (!trpc) return;
    const category = await trpc.categories.get.query({ categoryId });

    setCategory(category);
    setLoading(false);
  }, [categoryId]);

  const submit = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

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
  const [emojis, setEmojis] = useState<TJoinedEmoji[]>([]);

  const fetchEmojis = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;
    const emojis = await trpc.emojis.getAll.query({ serverId });

    setEmojis(emojis);
    setLoading(false);
  }, [serverId]);

  useEffect(() => {
    fetchEmojis();
  }, [fetchEmojis]);

  useSubscriptionRefetch((s) => s.server.emojis, fetchEmojis);

  return {
    emojis,
    refetch: fetchEmojis,
    loading
  };
};

export const useAdminRoles = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<TJoinedRole[]>([]);

  const fetchRoles = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;
    const roles = await trpc.roles.getAll.query({ serverId });

    setRoles(roles);
    setLoading(false);
  }, [serverId]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  useSubscriptionRefetch((s) => s.server.roles, fetchRoles);

  return {
    roles,
    refetch: fetchRoles,
    loading
  };
};

export const useAdminUsers = () => {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<TJoinedUser[]>([]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;
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
    if (!trpc) return;
    const { rolePermissions, userPermissions } =
      await trpc.channels.getPermissions.query({ channelId });

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
  const [auditLog, setAuditLog] = useState<
    Awaited<
      ReturnType<NonNullable<ReturnType<typeof getTRPCClient>>['users']['getInfo']['query']>
    >['auditLog']
  >([]);
  const [joinMethod, setJoinMethod] = useState<
    Awaited<
      ReturnType<NonNullable<ReturnType<typeof getTRPCClient>>['users']['getInfo']['query']>
    >['joinMethod']
  >(null);

  const fetchUser = useCallback(async () => {
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;
    const { user, logins, files, messages, auditLog, joinMethod } =
      await trpc.users.getInfo.query({
        userId
      });

    setUser(user);
    setLoading(false);
    setLogins(logins);
    setFiles(files);
    setMessages(messages);
    setAuditLog(auditLog);
    setJoinMethod(joinMethod);
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
    messages,
    auditLog,
    joinMethod
  };
};

export const useAdminInvites = (serverId: number | undefined) => {
  const [loading, setLoading] = useState(true);
  const [invites, setInvites] = useState<TJoinedInvite[]>([]);

  const fetchInvites = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);

    const trpc = getTRPCClient();
    if (!trpc) return;
    const invites = await trpc.invites.getAll.query({ serverId });

    setInvites(invites);
    setLoading(false);
  }, [serverId]);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  // Refetch when invite events arrive
  useEffect(() => {
    return onAppEvent('invites-changed', () => fetchInvites());
  }, [fetchInvites]);

  return {
    invites,
    refetch: fetchInvites,
    loading
  };
};
