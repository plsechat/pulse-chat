import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { joinServerByInvite, switchServer } from '@/features/app/actions';
import { connect, getHandshakeHash } from '@/features/server/actions';
import { useInfo } from '@/features/server/hooks';
import { getFileUrl, getUrlFromServer } from '@/helpers/get-file-url';
import {
  getLocalStorageItem,
  LocalStorageKey,
  removeLocalStorageItem,
  setLocalStorageItem
} from '@/helpers/storage';
import { useForm } from '@/hooks/use-form';
import { supabase } from '@/lib/supabase';
import type { Provider } from '@supabase/supabase-js';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  discord: 'Discord',
  facebook: 'Facebook',
  twitch: 'Twitch'
};

const Connect = memo(() => {
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);
  const info = useInfo();

  const loginForm = useForm<{
    email: string;
    password: string;
    rememberCredentials: boolean;
  }>({
    email: getLocalStorageItem(LocalStorageKey.EMAIL) || '',
    password: '',
    rememberCredentials: !!getLocalStorageItem(
      LocalStorageKey.REMEMBER_CREDENTIALS
    )
  });

  const registerForm = useForm<{
    displayName: string;
    email: string;
    password: string;
  }>({
    displayName: '',
    email: '',
    password: ''
  });

  const inviteCode = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const invite = urlParams.get('invite');
    return invite || undefined;
  }, []);

  const onRememberCredentialsChange = useCallback(
    (checked: boolean) => {
      loginForm.onChange('rememberCredentials', checked);

      if (checked) {
        setLocalStorageItem(LocalStorageKey.REMEMBER_CREDENTIALS, 'true');
      } else {
        removeLocalStorageItem(LocalStorageKey.REMEMBER_CREDENTIALS);
      }
    },
    // loginForm.onChange is a stable sub-property
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loginForm.onChange]
  );

  const onLoginClick = useCallback(async () => {
    setLoading(true);

    try {
      const url = getUrlFromServer();
      const response = await fetch(`${url}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: loginForm.values.email,
          password: loginForm.values.password
        })
      });

      if (!response.ok) {
        const data = await response.json();
        loginForm.setErrors(data.errors || {});
        return;
      }

      const data = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };

      await supabase.auth.setSession({
        access_token: data.accessToken,
        refresh_token: data.refreshToken
      });

      if (loginForm.values.rememberCredentials) {
        setLocalStorageItem(LocalStorageKey.EMAIL, loginForm.values.email);
      }

      await connect();

      // If there's an invite code, join that server and switch to it
      if (inviteCode) {
        try {
          const server = await joinServerByInvite(inviteCode);
          const hash = getHandshakeHash();
          if (server && hash) {
            await switchServer(server.id, hash);
          }
        } catch {
          // Invite join failed — user is still connected to default server
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(`Could not connect: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginForm.values, loginForm.setErrors, inviteCode]);

  const onRegisterClick = useCallback(async () => {
    setLoading(true);

    try {
      const url = getUrlFromServer();
      const response = await fetch(`${url}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: registerForm.values.email,
          password: registerForm.values.password,
          displayName: registerForm.values.displayName,
          invite: inviteCode
        })
      });

      if (!response.ok) {
        const data = await response.json();
        registerForm.setErrors(data.errors || {});
        return;
      }

      const data = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };

      await supabase.auth.setSession({
        access_token: data.accessToken,
        refresh_token: data.refreshToken
      });

      await connect();

      // If there's an invite code, join that server and switch to it
      if (inviteCode) {
        try {
          const server = await joinServerByInvite(inviteCode);
          const hash = getHandshakeHash();
          if (server && hash) {
            await switchServer(server.id, hash);
          }
        } catch {
          // Invite join failed — user is still connected to default server
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(`Could not create account: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerForm.values, registerForm.setErrors, inviteCode]);

  const onOAuthClick = useCallback(
    async (provider: string) => {
      const redirectTo = new URL(window.location.origin);

      if (inviteCode) {
        redirectTo.searchParams.set('invite', inviteCode);
      }

      await supabase.auth.signInWithOAuth({
        provider: provider as Provider,
        options: {
          redirectTo: redirectTo.toString()
        }
      });
    },
    [inviteCode]
  );

  const logoSrc = useMemo(() => {
    if (info?.logo) {
      return getFileUrl(info.logo);
    }

    return '/logo.png';
  }, [info]);

  const OAuthSection = useMemo(() => {
      const providers = info?.enabledAuthProviders ?? [];
      return providers.length > 0 ? (
        <>
          <div className="flex items-center gap-3 my-1">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground/60 uppercase tracking-wider">
              or
            </span>
            <Separator className="flex-1" />
          </div>
          <div className="flex gap-2">
            {providers.map((provider) => (
              <Button
                key={provider}
                className="flex-1"
                variant="outline"
                disabled={loading}
                onClick={() => onOAuthClick(provider)}
              >
                {OAUTH_PROVIDER_LABELS[provider] ?? provider}
              </Button>
            ))}
          </div>
        </>
      ) : null;
    },
    [info?.enabledAuthProviders, loading, onOAuthClick]
  );

  return (
    <>
      {/* Keyframe animation for gradient */}
      <style>{`
        @keyframes gradient-shift {
          0%, 100% {
            background-position: 0% 50%;
          }
          25% {
            background-position: 100% 50%;
          }
          50% {
            background-position: 100% 100%;
          }
          75% {
            background-position: 0% 100%;
          }
        }
        @keyframes float-orb {
          0%, 100% {
            transform: translateY(0px) scale(1);
            opacity: 0.3;
          }
          50% {
            transform: translateY(-20px) scale(1.1);
            opacity: 0.6;
          }
        }
        @keyframes float-orb-alt {
          0%, 100% {
            transform: translateY(0px) scale(1.05);
            opacity: 0.2;
          }
          50% {
            transform: translateY(15px) scale(0.95);
            opacity: 0.5;
          }
        }
        @keyframes pulse-glow {
          0%, 100% {
            opacity: 0.15;
            transform: scale(1);
          }
          50% {
            opacity: 0.3;
            transform: scale(1.05);
          }
        }
      `}</style>

      <div className="flex min-h-screen w-full bg-background">
        {/* Insecure connection banner */}
        {!window.isSecureContext && (
          <div className="fixed top-0 left-0 right-0 z-50 p-3">
            <Alert variant="destructive" className="max-w-lg mx-auto">
              <AlertTitle>Insecure Connection</AlertTitle>
              <AlertDescription className="text-xs">
                You are on an insecure connection (HTTP). Voice and video features
                may not work. Set up HTTPS for full functionality.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Left Panel — Branding Hero (hidden on mobile) */}
        <div
          className="hidden md:flex relative w-[45%] flex-col items-center justify-center overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, #1a0533 0%, #2d1b69 25%, #1e3a5f 50%, #4c1d95 75%, #1a0533 100%)',
            backgroundSize: '400% 400%',
            animation: 'gradient-shift 15s ease infinite'
          }}
        >
          {/* Floating decorative orbs */}
          <div
            className="absolute top-[15%] left-[20%] w-32 h-32 rounded-full bg-purple-500/20 blur-[60px]"
            style={{ animation: 'float-orb 8s ease-in-out infinite' }}
          />
          <div
            className="absolute bottom-[20%] right-[15%] w-40 h-40 rounded-full bg-indigo-400/15 blur-[80px]"
            style={{ animation: 'float-orb-alt 10s ease-in-out infinite' }}
          />
          <div
            className="absolute top-[60%] left-[10%] w-24 h-24 rounded-full bg-blue-500/20 blur-[50px]"
            style={{ animation: 'float-orb 12s ease-in-out infinite 2s' }}
          />
          <div
            className="absolute top-[30%] right-[25%] w-20 h-20 rounded-full bg-violet-400/25 blur-[40px]"
            style={{ animation: 'float-orb-alt 9s ease-in-out infinite 1s' }}
          />
          <div
            className="absolute bottom-[35%] left-[40%] w-48 h-48 rounded-full bg-purple-600/10 blur-[100px]"
            style={{ animation: 'pulse-glow 6s ease-in-out infinite' }}
          />

          {/* Branding content */}
          <div className="relative z-10 flex flex-col items-center text-center px-10">
            <img
              src={logoSrc}
              alt="Pulse Chat"
              className="w-[120px] h-[120px] mb-6 drop-shadow-2xl"
            />
            <h1 className="text-4xl font-bold text-white tracking-tight mb-3">
              Pulse Chat
            </h1>
            <p className="text-lg text-white/70 max-w-[320px] leading-relaxed">
              Pulse keeps things simple — fast voice, structured text, and a focus on stability.
            </p>
            <p className="text-sm text-white/50 max-w-[320px] leading-relaxed mt-2">
              No distractions. No bloat. Just connection.
            </p>
          </div>
        </div>

        {/* Right Panel — Auth Form */}
        <div className="flex-1 flex flex-col items-center justify-center relative px-4 py-8 md:px-10">
          {/* Mobile gradient accent bar */}
          <div
            className="md:hidden absolute top-0 left-0 right-0 h-1"
            style={{
              background:
                'linear-gradient(90deg, #7c3aed, #6366f1, #3b82f6, #7c3aed)',
              backgroundSize: '200% 100%',
              animation: 'gradient-shift 8s ease infinite'
            }}
          />

          {/* Mobile logo (shown only on small screens) */}
          <div className="md:hidden flex flex-col items-center mb-8">
            <img
              src={logoSrc}
              alt="Pulse Chat"
              className="w-16 h-16 mb-3 drop-shadow-lg"
            />
            <h1 className="text-xl font-bold text-foreground tracking-tight">
              Pulse Chat
            </h1>
          </div>

          <div className="w-full max-w-[420px]">
            {/* Auth card */}
            <div className="bg-card/50 backdrop-blur-xl border border-border/40 shadow-2xl rounded-2xl p-8 md:p-10">
              <Tabs
                value={activeTab}
                onValueChange={(v) => setActiveTab(v as 'login' | 'register')}
              >
                <TabsList className="w-full mb-8">
                  <TabsTrigger value="login" className="flex-1">
                    Sign In
                  </TabsTrigger>
                  <TabsTrigger value="register" className="flex-1">
                    Create Account
                  </TabsTrigger>
                </TabsList>

                {/* Login Tab */}
                <TabsContent value="login" className="mt-0">
                  <div className="flex flex-col gap-4">
                    <Group label="Email">
                      <Input
                        {...loginForm.r('email')}
                        type="email"
                        placeholder="you@example.com"
                        className="h-10"
                      />
                    </Group>
                    <Group label="Password">
                      <Input
                        {...loginForm.r('password')}
                        type="password"
                        placeholder="Enter your password"
                        onEnter={onLoginClick}
                        className="h-10"
                      />
                    </Group>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">
                        Remember me
                      </span>
                      <Switch
                        checked={loginForm.values.rememberCredentials}
                        onCheckedChange={onRememberCredentialsChange}
                      />
                    </div>
                    <Button
                      className="w-full mt-1 h-11 text-sm font-medium"
                      onClick={onLoginClick}
                      disabled={
                        loading ||
                        !loginForm.values.email ||
                        !loginForm.values.password
                      }
                    >
                      Sign In
                    </Button>
                    {OAuthSection}
                  </div>
                </TabsContent>

                {/* Register Tab */}
                <TabsContent value="register" className="mt-0">
                  <div className="flex flex-col gap-4">
                    <Group label="Display Name">
                      <Input
                        {...registerForm.r('displayName')}
                        type="text"
                        placeholder="How others will see you"
                        className="h-10"
                      />
                    </Group>
                    <Group label="Email">
                      <Input
                        {...registerForm.r('email')}
                        type="email"
                        placeholder="you@example.com"
                        className="h-10"
                      />
                    </Group>
                    <Group label="Password">
                      <Input
                        {...registerForm.r('password')}
                        type="password"
                        placeholder="At least 4 characters"
                        onEnter={onRegisterClick}
                        className="h-10"
                      />
                    </Group>
                    <Button
                      className="w-full mt-1 h-11 text-sm font-medium"
                      onClick={onRegisterClick}
                      disabled={
                        loading ||
                        !registerForm.values.displayName ||
                        !registerForm.values.email ||
                        !registerForm.values.password
                      }
                    >
                      Create Account
                    </Button>
                    {OAuthSection}

                    {(info?.registrationDisabled || !info?.allowNewUsers) && !inviteCode && (
                      <p className="text-xs text-muted-foreground text-center mt-2">
                        Registration requires an invite link. Ask an existing member
                        to invite you.
                      </p>
                    )}

                    {inviteCode && (
                      <Alert variant="info" className="mt-2">
                        <AlertTitle>You were invited</AlertTitle>
                        <AlertDescription>
                          <span className="font-mono text-xs">
                            Invite code: {inviteCode}
                          </span>
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </div>

            {/* Footer */}
            <div className="flex justify-center mt-6 text-xs text-muted-foreground/40">
              <span>v{VITE_APP_VERSION}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});

export { Connect };
