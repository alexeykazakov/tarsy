import { useState, useCallback } from 'react';
import { Box } from '@mui/material';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { KanbanColumn } from './KanbanColumn.tsx';
import { KanbanCardInner } from './KanbanCard.tsx';
import type { TriageGroup, TriageGroupKey } from '../../types/api.ts';
import type { DashboardSessionItem } from '../../types/session.ts';

interface TriageKanbanBoardProps {
  groups: Record<TriageGroupKey, TriageGroup | null>;
  onClaim: (sessionId: string) => void;
  onUnclaim: (sessionId: string) => void;
  onResolve: (sessionId: string) => void;
  onReopen: (sessionId: string) => void;
  onEditNote: (sessionId: string, currentNote: string) => void;
  onPageChange: (group: TriageGroupKey, page: number) => void;
  onPageSizeChange: (group: TriageGroupKey, pageSize: number) => void;
  actionLoading?: boolean;
  onCardHover?: (sessionId: string | null) => void;
}
function resolveDropAction(
  sourceGroup: TriageGroupKey,
  targetGroup: TriageGroupKey,
): 'claim' | 'unclaim' | 'resolve' | 'reopen' | null {
  if (sourceGroup === targetGroup) return null;
  if (sourceGroup === 'investigating' || targetGroup === 'investigating') return null;

  if (sourceGroup === 'needs_review' && targetGroup === 'in_progress') return 'claim';
  if (sourceGroup === 'in_progress' && targetGroup === 'needs_review') return 'unclaim';
  if (sourceGroup === 'needs_review' && targetGroup === 'resolved') return 'resolve';
  if (sourceGroup === 'in_progress' && targetGroup === 'resolved') return 'resolve';
  if (sourceGroup === 'resolved' && targetGroup === 'needs_review') return 'reopen';

  // resolved -> in_progress not a valid direct transition
  return null;
}

const COLUMN_ORDER: TriageGroupKey[] = ['investigating', 'needs_review', 'in_progress', 'resolved'];

export function TriageKanbanBoard({
  groups,
  onClaim,
  onUnclaim,
  onResolve,
  onReopen,
  onEditNote,
  onPageChange,
  onPageSizeChange,
  actionLoading,
  onCardHover,
}: TriageKanbanBoardProps) {
  const [activeCard, setActiveCard] = useState<{
    session: DashboardSessionItem;
    group: TriageGroupKey;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const findSession = useCallback(
    (sessionId: string): { session: DashboardSessionItem; group: TriageGroupKey } | null => {
      for (const key of COLUMN_ORDER) {
        const g = groups[key];
        if (!g) continue;
        const found = g.sessions.find((s) => s.id === sessionId);
        if (found) return { session: found, group: key };
      }
      return null;
    },
    [groups],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const data = active.data.current as { group: TriageGroupKey; session: DashboardSessionItem } | undefined;
      if (data) {
        setActiveCard({ session: data.session, group: data.group });
      } else {
        const found = findSession(active.id as string);
        if (found) setActiveCard(found);
      }
    },
    [findSession],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCard(null);
      const { active, over } = event;
      if (!over) return;

      const sourceData = active.data.current as { group: TriageGroupKey } | undefined;
      const sourceGroup = sourceData?.group;
      if (!sourceGroup) return;

      // Determine target group from the droppable column
      let targetGroup: TriageGroupKey | undefined;
      const overData = over.data.current as { group?: TriageGroupKey } | undefined;
      if (overData?.group) {
        targetGroup = overData.group;
      } else {
        // over.id might be a column ID like "column-needs_review"
        const overId = over.id as string;
        if (overId.startsWith('column-')) {
          targetGroup = overId.replace('column-', '') as TriageGroupKey;
        }
      }
      if (!targetGroup) return;

      const action = resolveDropAction(sourceGroup, targetGroup);
      if (!action) return;

      const sessionId = active.id as string;
      switch (action) {
        case 'claim':
          onClaim(sessionId);
          break;
        case 'unclaim':
          onUnclaim(sessionId);
          break;
        case 'resolve':
          onResolve(sessionId);
          break;
        case 'reopen':
          onReopen(sessionId);
          break;
      }
    },
    [onClaim, onUnclaim, onResolve, onReopen],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <Box
        sx={{
          display: 'flex',
          gap: 1.5,
          alignItems: 'stretch',
          minHeight: 400,
          maxHeight: 'calc(100vh - 220px)',
          overflow: 'hidden',
        }}
      >
        {COLUMN_ORDER.map((key) => (
          <KanbanColumn
            key={key}
            groupKey={key}
            groupData={groups[key]}
            onClaim={onClaim}
            onUnclaim={onUnclaim}
            onResolve={onResolve}
            onReopen={onReopen}
            onEditNote={onEditNote}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            actionLoading={actionLoading}
            onCardHover={onCardHover}
          />
        ))}
      </Box>

      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <Box sx={{ width: 320 }}>
            <KanbanCardInner
              session={activeCard.session}
              group={activeCard.group}
              isDragOverlay
            />
          </Box>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
