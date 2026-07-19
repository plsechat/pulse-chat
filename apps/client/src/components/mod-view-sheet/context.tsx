import type { TFile, TJoinedUser, TLogin, TMessage } from '@pulse/shared';
import { createContext, useContext } from 'react';

enum ModViewScreen {
  FILES = 'FILES',
  MESSAGES = 'MESSAGES',
  LINKS = 'LINKS',
  LOGINS = 'LOGINS',
  AUDIT_LOG = 'AUDIT_LOG'
}

type TAuditLogEntry = {
  id: number;
  userId: number;
  type: string;
  details: unknown;
  ip: string | null;
  serverId: number | null;
  createdAt: number;
};

type TJoinMethod = {
  inviteCode: string;
  inviterId: number | null;
  inviterName: string | null;
} | null;

type TModViewContext = {
  refetch: () => void;
  userId: number;
  user: TJoinedUser;
  logins: TLogin[];
  files: TFile[];
  messages: TMessage[];
  view: ModViewScreen | undefined;
  setView: (view: ModViewScreen | undefined) => void;
  links: string[];
  auditLog: TAuditLogEntry[];
  joinMethod: TJoinMethod;
};

const ModViewContext = createContext<TModViewContext>({
  refetch: () => {},
  userId: -1,
  logins: [],
  files: [],
  messages: [],
  user: {} as TJoinedUser,
  view: undefined,
  setView: () => {},
  links: [],
  auditLog: [],
  joinMethod: null
});

const useModViewContext = () => useContext(ModViewContext);

// eslint-disable-next-line react-refresh/only-export-components
export { ModViewContext, ModViewScreen, useModViewContext };
export type { TAuditLogEntry, TJoinMethod, TModViewContext };
