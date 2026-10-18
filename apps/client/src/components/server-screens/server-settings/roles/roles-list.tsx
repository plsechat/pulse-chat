import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useActiveServerId } from '@/features/app/hooks';
import { useIsOwnUserOwner, useOwnUserRoles } from '@/features/server/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TJoinedRole } from '@pulse/server/types';
import { GripVertical, Plus } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  getRoleCeiling,
  isRoleMovable,
  reorderMovableRoles,
  sortRolesByPosition
} from './order';

type TRolesListProps = {
  roles: TJoinedRole[];
  selectedRoleId: number | undefined;
  setSelectedRoleId: (roleId: number) => void;
  refetch: () => void;
};

type TRoleRowProps = {
  role: TJoinedRole;
  selected: boolean;
  movable: boolean;
  onSelect: () => void;
};

const RoleRow = memo(({ role, selected, movable, onSelect }: TRoleRowProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: role.id, disabled: !movable });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1
      }}
      className={cn(
        'flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent',
        selected && 'bg-accent'
      )}
    >
      {movable ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label="Drag to reorder"
          className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      ) : (
        // Keeps the names aligned for roles the caller cannot move
        // (the owner role, and anything at or above their own rank).
        <span className="w-6 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left text-sm"
      >
        <div
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: role.color }}
        />
        <span className="truncate">{role.name}</span>
      </button>
    </div>
  );
});

const RolesList = memo(
  ({ roles, selectedRoleId, setSelectedRoleId, refetch }: TRolesListProps) => {
    const activeServerId = useActiveServerId();
    const ownRoles = useOwnUserRoles();
    const isOwner = useIsOwnUserOwner();

    const ceiling = useMemo(
      () => getRoleCeiling(ownRoles, isOwner),
      [ownRoles, isOwner]
    );
    const sorted = useMemo(() => sortRolesByPosition(roles), [roles]);
    const movableIds = useMemo(
      () => sorted.filter((r) => isRoleMovable(r, ceiling)).map((r) => r.id),
      [sorted, ceiling]
    );

    const sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
    );

    const handleDragEnd = useCallback(
      async (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over) return;
        const orderedRoleIds = reorderMovableRoles(
          movableIds,
          active.id as number,
          over.id as number
        );
        if (!orderedRoleIds) return;

        const trpc = getTRPCClient();
        if (!trpc) return;
        try {
          await trpc.roles.reorder.mutate({ orderedRoleIds });
          refetch();
        } catch (err) {
          toast.error(getTrpcError(err, 'Could not reorder roles'));
        }
      },
      [movableIds, refetch]
    );

    const onAddRole = useCallback(async () => {
      if (!activeServerId) return;
      const trpc = getTRPCClient();
      if (!trpc) return;

      try {
        const newRoleId = await trpc.roles.add.mutate({ serverId: activeServerId });

        await refetch();

        setSelectedRoleId(newRoleId);
        toast.success('Role created');
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not create role'));
      }
    }, [refetch, setSelectedRoleId, activeServerId]);

    return (
      <Card className="w-full flex-shrink-0 md:w-64">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Roles</CardTitle>
            <Button size="icon" variant="ghost" onClick={onAddRole} aria-label="Create role">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Highest first. Drag a role to change its rank.
          </p>
        </CardHeader>
        <CardContent className="space-y-1 p-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={movableIds}
              strategy={verticalListSortingStrategy}
            >
              {sorted.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  selected={selectedRoleId === role.id}
                  movable={movableIds.includes(role.id)}
                  onSelect={() => setSelectedRoleId(role.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </CardContent>
      </Card>
    );
  }
);

export { RolesList };
