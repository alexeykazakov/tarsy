import {
  Box,
  Typography,
  Chip,
  Paper,
} from '@mui/material';
import {
  Search as SearchIcon,
  RateReview,
  AssignmentTurnedIn,
  CheckCircleOutline,
} from '@mui/icons-material';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { KanbanCard } from './KanbanCard.tsx';
import { PaginationControls } from './PaginationControls.tsx';
import type { DashboardSessionItem } from '../../types/session.ts';
import type { TriageGroup, TriageGroupKey } from '../../types/api.ts';

interface KanbanColumnProps {
  groupKey: TriageGroupKey;
  groupData: TriageGroup | null;
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

interface ColumnConfig {
  label: string;
  icon: React.ReactElement;
  color: string;
  accentBorder?: boolean;
}

const columnConfigs: Record<TriageGroupKey, ColumnConfig> = {
  investigating: {
    label: 'Investigating',
    icon: <SearchIcon sx={{ fontSize: 18 }} />,
    color: '#1976d2',
  },
  needs_review: {
    label: 'Needs Review',
    icon: <RateReview sx={{ fontSize: 18 }} />,
    color: '#ed6c02',
    accentBorder: true,
  },
  in_progress: {
    label: 'In Progress',
    icon: <AssignmentTurnedIn sx={{ fontSize: 18 }} />,
    color: '#0288d1',
  },
  resolved: {
    label: 'Resolved',
    icon: <CheckCircleOutline sx={{ fontSize: 18 }} />,
    color: '#2e7d32',
  },
};

export function KanbanColumn({
  groupKey,
  groupData,
  onClaim,
  onUnclaim,
  onResolve,
  onReopen,
  onEditNote,
  onPageChange,
  onPageSizeChange,
  actionLoading,
  onCardHover,
}: KanbanColumnProps) {
  const config = columnConfigs[groupKey];
  const isDropDisabled = groupKey === 'investigating';
  const sessions: DashboardSessionItem[] = groupData?.sessions ?? [];
  const count = groupData?.count ?? 0;
  const showPagination = count > 10;

  const { setNodeRef, isOver } = useDroppable({
    id: `column-${groupKey}`,
    data: { group: groupKey },
    disabled: isDropDisabled,
  });

  const sessionIds = sessions.map((s) => s.id);

  return (
    <Paper
      variant="outlined"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 280,
        maxWidth: 400,
        overflow: 'hidden',
        borderTop: `3px solid ${config.color}`,
        transition: 'box-shadow 0.2s',
        boxShadow: isOver && !isDropDisabled ? 4 : undefined,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          backgroundColor: 'background.default',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ color: config.color, display: 'flex', alignItems: 'center' }}>
          {config.icon}
        </Box>
        <Typography variant="subtitle2" fontWeight={600} sx={{ flex: 1 }}>
          {config.label}
        </Typography>
        <Chip
          label={count}
          size="small"
          sx={{
            height: 22,
            minWidth: 28,
            fontSize: '0.75rem',
            fontWeight: 600,
            backgroundColor: count === 0 ? 'action.disabledBackground' : config.color,
            color: count === 0 ? 'text.disabled' : '#fff',
          }}
        />
      </Box>

      {/* Card area */}
      <SortableContext items={sessionIds} strategy={verticalListSortingStrategy}>
        <Box
          ref={setNodeRef}
          sx={{
            flex: 1,
            overflowY: 'auto',
            p: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            minHeight: 80,
            backgroundColor: isOver && !isDropDisabled
              ? 'action.hover'
              : 'transparent',
            transition: 'background-color 0.2s',
          }}
        >
          {sessions.length === 0 ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, py: 2 }}>
              <Typography variant="body2" color="text.disabled">
                No sessions
              </Typography>
            </Box>
          ) : (
            sessions.map((session) => (
              <KanbanCard
                key={session.id}
                session={session}
                group={groupKey}
                onClaim={onClaim}
                onUnclaim={onUnclaim}
                onResolve={onResolve}
                onReopen={onReopen}
                onEditNote={onEditNote}
                actionLoading={actionLoading}
                onHover={onCardHover}
              />
            ))
          )}
        </Box>
      </SortableContext>

      {/* Pagination */}
      {showPagination && groupData && (
        <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
          <PaginationControls
            pagination={{
              page: groupData.page,
              pageSize: groupData.page_size,
              totalPages: groupData.total_pages,
              totalItems: groupData.count,
            }}
            onPageChange={(page) => onPageChange(groupKey, page)}
            onPageSizeChange={(pageSize) => onPageSizeChange(groupKey, pageSize)}
          />
        </Box>
      )}
    </Paper>
  );
}
