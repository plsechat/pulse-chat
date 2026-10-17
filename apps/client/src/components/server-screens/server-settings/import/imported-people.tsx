import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { UserAvatar } from '@/components/user-avatar';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useUsers } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TImportedPerson } from '@pulse/server/types';
import { Link2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { formatCount } from './format';

type TImportedPeopleProps = {
  serverId: number;
};

/** The roster shown in a picker: at most this many rows, filtered by the search box. */
const MAX_PICKER_ROWS = 50;

type TRowProps = {
  person: TImportedPerson;
  members: { id: number; name: string }[];
  busy: boolean;
  onLink: (person: TImportedPerson, userId: number) => Promise<void>;
};

const PersonRow = memo(({ person, members, busy, onLink }: TRowProps) => {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string>('');

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle ? members.filter((m) => m.name.toLowerCase().includes(needle)) : members;
    return list.slice(0, MAX_PICKER_ROWS);
  }, [members, query]);

  const chosenId = Number(chosen);
  const chosenMember = members.find((m) => m.id === chosenId);

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar userId={person.userId} className="h-8 w-8" showStatusBadge={false} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{person.name}</p>
          <p className="text-xs text-muted-foreground">
            {formatCount(person.messageCount)} message{person.messageCount === 1 ? '' : 's'} here
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a member"
          aria-label={`Find a member for ${person.name}`}
          className="h-9 w-36"
        />
        <Select value={chosen} onValueChange={setChosen} disabled={busy}>
          <SelectTrigger className="h-9 w-44" aria-label={`Member for ${person.name}`}>
            <SelectValue placeholder="Link to member" />
          </SelectTrigger>
          <SelectContent>
            {candidates.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No member matches</div>
            ) : (
              candidates.map((member) => (
                <SelectItem key={member.id} value={String(member.id)}>
                  {member.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={busy || !chosenMember}
          onClick={() => chosenMember && onLink(person, chosenMember.id)}
        >
          <Link2 className="mr-2 h-4 w-4" aria-hidden /> Link
        </Button>
      </div>
    </li>
  );
});

/**
 * Server Settings → Import → "Imported people". Every placeholder an
 * import left in this server, with a picker to hand its history to the
 * member it belongs to — for the people who signed in with another
 * account, or never will. The link is the same one-way merge a
 * matching sign-in performs; the card says so, because there is no
 * unlink.
 */
const ImportedPeople = memo(({ serverId }: TImportedPeopleProps) => {
  const [people, setPeople] = useState<TImportedPerson[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const roster = useUsers();

  const load = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      setPeople(await trpc.import.listPlaceholders.query({ serverId }));
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not load the imported people'));
    }
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  // Members a history can go to: everyone in the roster who is not an
  // imported placeholder themselves (the server refuses those too).
  const members = useMemo(() => {
    const placeholderIds = new Set((people ?? []).map((p) => p.userId));
    return roster
      .filter((user) => !placeholderIds.has(user.id) && !user.deletedAt && !user.banned)
      .map((user) => ({ id: user.id, name: user.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [people, roster]);

  const onLink = useCallback(
    async (person: TImportedPerson, userId: number) => {
      const member = members.find((m) => m.id === userId);
      const yes = await requestConfirmation({
        title: `Link ${person.name} to ${member?.name ?? 'this member'}?`,
        message: `${formatCount(person.messageCount)} imported message${person.messageCount === 1 ? '' : 's'}, pins, event signups and roles move to ${member?.name ?? 'the member'}. This is one way: the imported entry disappears and cannot be unlinked.`,
        confirmLabel: 'Link',
        cancelLabel: 'Keep separate',
        variant: 'danger'
      });
      if (!yes) return;

      const trpc = getTRPCClient();
      if (!trpc) return;
      setBusyId(person.userId);
      try {
        await trpc.import.linkPlaceholder.mutate({ serverId, placeholderUserId: person.userId, userId });
        setPeople((current) => (current ?? []).filter((p) => p.userId !== person.userId));
        toast.success(`${person.name} is now ${member?.name ?? 'that member'}`);
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not link them'));
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load, members, serverId]
  );

  if (!people || people.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Imported people</CardTitle>
        <CardDescription>
          {people.length} imported {people.length === 1 ? 'person has' : 'people have'} not been claimed by an
          account yet. Someone who signs in with the same account they used over there takes theirs over
          automatically; link the rest by hand here. A link is one way — the imported entry merges into the
          member and cannot be separated again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {people.map((person) => (
            <PersonRow
              key={person.userId}
              person={person}
              members={members}
              busy={busyId === person.userId}
              onLink={onLink}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
});

export { ImportedPeople };
