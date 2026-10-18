import type { db } from '..';
import type { TEventRole } from '../../types';
import { eventRosterTemplates } from '../schema';

/**
 * The stock roster templates and the insert both the server-create route
 * and the bootstrap seed run. This lives apart from db/queries/events.ts
 * on purpose: that module pulls in the voice runtime (attendance
 * sampling), and the seed is imported while the config module is still
 * loading — a static edge from here to the runtime would read config
 * before it exists and the server would never boot.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_ROSTER_TEMPLATES: { name: string; roles: TEventRole[] }[] = [
  {
    name: 'Classic raid',
    roles: [
      { key: 'tank', label: 'Tank', cap: 2, color: '#60a5fa' },
      { key: 'healer', label: 'Healer', cap: 4, color: '#5ee29a' },
      { key: 'dps', label: 'DPS', cap: 14, color: '#ff5c6c' }
    ]
  },
  {
    name: 'Small group',
    roles: [
      { key: 'tank', label: 'Tank', cap: 1, color: '#60a5fa' },
      { key: 'healer', label: 'Healer', cap: 1, color: '#5ee29a' },
      { key: 'dps', label: 'DPS', cap: 3, color: '#ff5c6c' }
    ]
  },
  {
    name: 'Flex',
    roles: [{ key: 'flex', label: 'Flex', cap: null, color: '#ffb454' }]
  }
];

/** The three stock templates every server starts with (create route + bootstrap seed). */
const insertDefaultRosterTemplates = async (
  tx: Tx,
  serverId: number,
  now: number
) => {
  await tx.insert(eventRosterTemplates).values(
    DEFAULT_ROSTER_TEMPLATES.map((template) => ({
      serverId,
      name: template.name,
      roles: template.roles,
      createdAt: now
    }))
  );
};

export { DEFAULT_ROSTER_TEMPLATES, insertDefaultRosterTemplates };
