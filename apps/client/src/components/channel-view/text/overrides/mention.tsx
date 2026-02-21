import { UserPopover } from '@/components/user-popover';
import { useRoleById } from '@/features/server/roles/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { memo } from 'react';

type TMentionOverrideProps = {
  type: 'user' | 'role' | 'all';
  id: number;
  name: string;
};

const UserMention = memo(({ id, name }: { id: number; name: string }) => {
  const user = useUserById(id);
  const displayName = user?.name ?? name;
  const isFederated = user?._identity?.includes('@');

  return (
    <UserPopover userId={id}>
      <span className={isFederated ? 'mention mention-federated' : 'mention'}>
        @{displayName}{isFederated && <span className="mention-fed-icon" aria-label="Federated user">🌐</span>}
      </span>
    </UserPopover>
  );
});

const RoleMention = memo(({ id, name }: { id: number; name: string }) => {
  const role = useRoleById(id);
  const displayName = role?.name ?? name;
  const color = role?.color;

  return (
    <span
      className="mention"
      style={
        color
          ? {
              color,
              backgroundColor: `${color}26`
            }
          : undefined
      }
    >
      @{displayName}
    </span>
  );
});

const AllMention = memo(() => {
  return (
    <span className="mention" style={{ color: '#f59e0b', backgroundColor: '#f59e0b26' }}>
      @all
    </span>
  );
});

const MentionOverride = memo(({ type, id, name }: TMentionOverrideProps) => {
  if (type === 'all') {
    return <AllMention />;
  }

  if (type === 'user') {
    return <UserMention id={id} name={name} />;
  }

  return <RoleMention id={id} name={name} />;
});

export { MentionOverride };
