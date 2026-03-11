import { forwardRef } from 'react';
import {
  Box,
  Card,
  Typography,
  Button,
  IconButton,
  Tooltip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  Undo,
  StickyNote2Outlined,
  Check,
  NotInterested,
  MoreVert,
  OpenInNew,
} from '@mui/icons-material';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { StatusBadge } from '../common/StatusBadge.tsx';
import { ScoreBadge } from '../common/ScoreBadge.tsx';
import { formatTimestamp } from '../../utils/format.ts';
import { sessionDetailPath, sessionScoringPath } from '../../constants/routes.ts';
import type { DashboardSessionItem } from '../../types/session.ts';
import type { TriageGroupKey } from '../../types/api.ts';

interface KanbanCardProps {
  session: DashboardSessionItem;
  group: TriageGroupKey;
  onClaim?: (sessionId: string) => void;
  onUnclaim?: (sessionId: string) => void;
  onResolve?: (sessionId: string) => void;
  onReopen?: (sessionId: string) => void;
  onEditNote?: (sessionId: string, currentNote: string) => void;
  actionLoading?: boolean;
  isDragOverlay?: boolean;
  onHover?: (sessionId: string | null) => void;
}

const resolutionReasonConfig: Record<string, { label: string; color: string }> = {
  actioned: { label: 'Actioned', color: 'success.main' },
  dismissed: { label: 'Dismissed', color: 'warning.main' },
};

const KanbanCardInner = forwardRef<HTMLDivElement, KanbanCardProps & {
  style?: React.CSSProperties;
  listeners?: SyntheticListenerMap;
  attributes?: DraggableAttributes;
  isDragging?: boolean;
}>(function KanbanCardInner(
  {
    session,
    group,
    onClaim,
    onUnclaim,
    onResolve,
    onReopen,
    onEditNote,
    actionLoading,
    isDragOverlay,
    onHover,
    style,
    listeners,
    attributes,
    isDragging,
  },
  ref,
) {
  const navigate = useNavigate();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const handleCardClick = () => {
    if (isDragOverlay) return;
    navigate(sessionDetailPath(session.id));
  };

  const handleOpenNewTab = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(sessionDetailPath(session.id), '_blank');
  };

  const summary = session.executive_summary;
  const truncatedSummary = summary && summary.length > 100
    ? summary.slice(0, 100) + '...'
    : summary;

  const hasScoring = session.scoring_status || session.latest_score != null;

  return (
    <Card
      ref={ref}
      variant="outlined"
      onClick={handleCardClick}
      onMouseEnter={() => onHover?.(session.id)}
      onMouseLeave={() => onHover?.(null)}
      sx={{
        p: 1.5,
        cursor: isDragOverlay ? 'grabbing' : 'pointer',
        opacity: isDragging ? 0.4 : 1,
        transition: isDragging ? 'none' : 'box-shadow 0.15s, opacity 0.15s',
        '&:hover': isDragOverlay ? {} : {
          boxShadow: 3,
          '& .kanban-actions': { opacity: 1 },
        },
        ...style,
      }}
      {...attributes}
      {...listeners}
    >
      {/* Row 1: Status + Alert type + Score + Actions */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
        <StatusBadge status={session.status} size="small" />
        {group === 'resolved' && session.resolution_reason && (
          <Tooltip title={resolutionReasonConfig[session.resolution_reason]?.label ?? session.resolution_reason}>
            <Box
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: '1px solid',
                borderColor: resolutionReasonConfig[session.resolution_reason]?.color ?? 'text.secondary',
                color: resolutionReasonConfig[session.resolution_reason]?.color ?? 'text.secondary',
              }}
            >
              {session.resolution_reason === 'actioned'
                ? <Check sx={{ fontSize: 12 }} />
                : <NotInterested sx={{ fontSize: 12 }} />}
            </Box>
          </Tooltip>
        )}
        <Typography variant="body2" fontWeight={600} noWrap sx={{ flex: 1, minWidth: 0 }}>
          {session.alert_type ?? '—'}
        </Typography>
        {hasScoring && (
          <Box
            onClick={(e) => {
              e.stopPropagation();
              navigate(sessionScoringPath(session.id));
            }}
            sx={{ cursor: 'pointer', flexShrink: 0 }}
          >
            <ScoreBadge
              score={session.latest_score}
              scoringStatus={session.scoring_status}
              variant="pill"
              showLabel={false}
            />
          </Box>
        )}
      </Box>

      {/* Row 2: Author / Assignee / Time */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: truncatedSummary ? 0.5 : 0 }}>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {session.author ?? '—'}
          {session.assignee && (
            <> &rarr; {session.assignee}</>
          )}
        </Typography>
        <Tooltip title={formatTimestamp(session.created_at, 'absolute')}>
          <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
            {formatTimestamp(session.created_at, 'short')}
          </Typography>
        </Tooltip>
      </Box>

      {/* Row 3: Summary snippet */}
      {truncatedSummary && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: 1.4,
            mb: 0.5,
          }}
        >
          {truncatedSummary}
        </Typography>
      )}

      {/* Row 4: Actions */}
      {group !== 'investigating' && !isDragOverlay && (
        <Box
          className="kanban-actions"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            mt: 0.5,
            opacity: 0,
            transition: 'opacity 0.15s',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {group === 'needs_review' && (
            <>
              <Button
                size="small"
                variant="contained"
                disabled={actionLoading}
                onClick={() => onClaim?.(session.id)}
                sx={{ textTransform: 'none', fontSize: '0.7rem', py: 0.25, px: 1, minWidth: 0 }}
              >
                Claim
              </Button>
              <Button
                size="small"
                variant="contained"
                color="success"
                disabled={actionLoading}
                onClick={() => onResolve?.(session.id)}
                sx={{ textTransform: 'none', fontSize: '0.7rem', py: 0.25, px: 1, minWidth: 0 }}
              >
                Resolve
              </Button>
            </>
          )}

          {group === 'in_progress' && (
            <>
              <Button
                size="small"
                variant="contained"
                color="success"
                disabled={actionLoading}
                onClick={() => onResolve?.(session.id)}
                sx={{ textTransform: 'none', fontSize: '0.7rem', py: 0.25, px: 1, minWidth: 0 }}
              >
                Resolve
              </Button>
              <Tooltip title="Unclaim">
                <IconButton
                  size="small"
                  disabled={actionLoading}
                  onClick={() => onUnclaim?.(session.id)}
                >
                  <Undo sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </>
          )}

          {group === 'resolved' && (
            <>
              <Tooltip title={session.resolution_note || 'Add note'}>
                <IconButton
                  size="small"
                  onClick={() => onEditNote?.(session.id, session.resolution_note ?? '')}
                  sx={{ color: session.resolution_note ? 'primary.main' : 'text.disabled' }}
                >
                  <StickyNote2Outlined sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Reopen">
                <IconButton
                  size="small"
                  disabled={actionLoading}
                  onClick={() => onReopen?.(session.id)}
                >
                  <Undo sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </>
          )}

          {/* Three-dot menu */}
          <Box sx={{ ml: 'auto' }}>
            <IconButton
              size="small"
              onClick={(e) => setMenuAnchor(e.currentTarget)}
            >
              <MoreVert sx={{ fontSize: 14 }} />
            </IconButton>
            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={() => setMenuAnchor(null)}
              onClick={(e) => e.stopPropagation()}
            >
              <MenuItem onClick={(e) => { setMenuAnchor(null); handleOpenNewTab(e); }}>
                <ListItemIcon><OpenInNew fontSize="small" /></ListItemIcon>
                <ListItemText>Open in new tab</ListItemText>
              </MenuItem>
              {group === 'needs_review' && (
                <MenuItem disabled={actionLoading} onClick={() => { setMenuAnchor(null); onClaim?.(session.id); }}>
                  <ListItemText>Claim</ListItemText>
                </MenuItem>
              )}
              {group === 'in_progress' && (
                <MenuItem disabled={actionLoading} onClick={() => { setMenuAnchor(null); onUnclaim?.(session.id); }}>
                  <ListItemText>Unclaim</ListItemText>
                </MenuItem>
              )}
              {(group === 'needs_review' || group === 'in_progress') && (
                <MenuItem disabled={actionLoading} onClick={() => { setMenuAnchor(null); onResolve?.(session.id); }}>
                  <ListItemText>Resolve</ListItemText>
                </MenuItem>
              )}
              {group === 'resolved' && (
                <MenuItem disabled={actionLoading} onClick={() => { setMenuAnchor(null); onReopen?.(session.id); }}>
                  <ListItemText>Reopen</ListItemText>
                </MenuItem>
              )}
            </Menu>
          </Box>
        </Box>
      )}
    </Card>
  );
});

export function KanbanCard(props: KanbanCardProps) {
  const { session, group, isDragOverlay } = props;
  const isDraggable = group !== 'investigating' && !isDragOverlay;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: session.id,
    data: { group, session },
    disabled: !isDraggable,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  };

  return (
    <KanbanCardInner
      ref={setNodeRef}
      style={style}
      listeners={isDraggable ? listeners : undefined}
      attributes={isDraggable ? attributes : undefined}
      isDragging={isDragging}
      {...props}
    />
  );
}

export { KanbanCardInner };
