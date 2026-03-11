import {
  Box,
  ToggleButtonGroup,
  ToggleButton,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { Refresh, ViewList, ViewKanban } from '@mui/icons-material';
import { TRIAGE_ASSIGNEE, type TriageFilter, type TriageLayout } from '../../types/dashboard.ts';
import type { TriageGroup, TriageGroupKey } from '../../types/api.ts';

interface TriageFilterBarProps {
  filters: TriageFilter;
  onFiltersChange: (filters: TriageFilter) => void;
  layout: TriageLayout;
  onLayoutChange: (layout: TriageLayout) => void;
  onRefresh: () => void;
  groups: Record<TriageGroupKey, TriageGroup | null>;
  loading?: boolean;
}

export function TriageFilterBar({
  filters,
  onFiltersChange,
  layout,
  onLayoutChange,
  onRefresh,
  groups,
  loading,
}: TriageFilterBarProps) {
  const handleAssigneeChange = (_: React.MouseEvent<HTMLElement>, value: string | null) => {
    if (value) {
      onFiltersChange({ ...filters, assignee: value as TriageFilter['assignee'] });
    }
  };

  const handleLayoutChange = (_: React.MouseEvent<HTMLElement>, value: string | null) => {
    if (value) {
      onLayoutChange(value as TriageLayout);
    }
  };

  const totalCount = Object.values(groups).reduce((sum, g) => sum + (g?.count ?? 0), 0);
  const hasData = Object.values(groups).some(g => g !== null);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 0.5,
        py: 1,
      }}
    >
      <ToggleButtonGroup
        value={filters.assignee}
        exclusive
        onChange={handleAssigneeChange}
        size="small"
      >
        <ToggleButton value={TRIAGE_ASSIGNEE.ALL} sx={{ textTransform: 'none', px: 2 }}>
          All
        </ToggleButton>
        <ToggleButton value={TRIAGE_ASSIGNEE.MINE} sx={{ textTransform: 'none', px: 2 }}>
          Mine
        </ToggleButton>
        <ToggleButton value={TRIAGE_ASSIGNEE.UNASSIGNED} sx={{ textTransform: 'none', px: 2 }}>
          Unassigned
        </ToggleButton>
      </ToggleButtonGroup>

      <Box sx={{ flexGrow: 1 }} />

      {hasData && (
        <Typography variant="body2" color="text.secondary">
          {totalCount} session{totalCount !== 1 ? 's' : ''}
        </Typography>
      )}

      <ToggleButtonGroup
        value={layout}
        exclusive
        onChange={handleLayoutChange}
        size="small"
      >
        <ToggleButton value="list" aria-label="List view">
          <Tooltip title="List view"><ViewList fontSize="small" /></Tooltip>
        </ToggleButton>
        <ToggleButton value="board" aria-label="Board view">
          <Tooltip title="Board view"><ViewKanban fontSize="small" /></Tooltip>
        </ToggleButton>
      </ToggleButtonGroup>

      <Tooltip title="Refresh triage data">
        <span>
          <IconButton size="small" onClick={onRefresh} disabled={loading}>
            <Refresh fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
