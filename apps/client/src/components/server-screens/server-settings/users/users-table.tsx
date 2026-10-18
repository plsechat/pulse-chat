import { PaginatedTable } from '@/components/paginated-table';
import type { TJoinedUser } from '@pulse/server/types';
import { memo, useCallback } from 'react';
import { TableUser } from './table-user';

type TUsersTableProps = {
  users: TJoinedUser[];
};

const UsersTable = memo(({ users }: TUsersTableProps) => {
  const searchFilter = useCallback((user: TJoinedUser, searchTerm: string) => {
    const query = searchTerm.toLowerCase();
    return (
      user.name.toLowerCase().includes(query) ||
      user.supabaseId?.toLowerCase().includes(query)
    );
  }, []);

  return (
    <PaginatedTable
      items={users}
      renderRow={(user) => <TableUser user={user} />}
      searchFilter={searchFilter}
      headerColumns={
        <>
          <div>Avatar</div>
          <div>User</div>
          <div>Roles</div>
          <div>Joined At</div>
          <div>Last Join</div>
          <div>Status</div>
          <div>Actions</div>
        </>
      }
      gridCols="grid-cols-[3rem_minmax(7rem,1fr)_minmax(0,6rem)_5.25rem_5.25rem_3.25rem_2.25rem]"
      itemsPerPage={8}
      searchPlaceholder="Search users by name or identity..."
      emptyMessage="No users found"
    />
  );
});

export { UsersTable };
