import { useState, useEffect, memo } from 'react';
import { Box, Typography, Collapse, IconButton, Chip, alpha } from '@mui/material';
import { ExpandMore, ExpandLess, SmartToyOutlined } from '@mui/icons-material';
import CopyButton from '../shared/CopyButton';
import ClaudeCodeSession from './ClaudeCodeSession';
import type { FlowItem } from '../../utils/timelineParser';

interface ClaudeCodeItemProps {
  item: FlowItem;
  expandAll?: boolean;
  searchTerm?: string;
}

function ClaudeCodeItem({ item, expandAll = false }: ClaudeCodeItemProps) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => { setExpanded(expandAll || true); }, [expandAll]);
  const isExpanded = expandAll || expanded;

  const content = item.content || '';
  const meta = item.metadata?.cc_event as Record<string, unknown> | undefined;
  const numTurns = meta?.num_turns as number | undefined;
  const costUsd = meta?.total_cost_usd as number | undefined;
  const durationMs = meta?.duration_ms as number | undefined;

  const statParts: string[] = [];
  if (numTurns != null) statParts.push(`${numTurns} turns`);
  if (costUsd != null) statParts.push(`$${costUsd.toFixed(4)}`);
  if (durationMs != null) statParts.push(`${(durationMs / 1000).toFixed(1)}s`);

  return (
    <Box
      data-flow-item-id={item.id}
      sx={(theme) => ({
        ml: 4, my: 0.5, mr: 1,
        border: '1px solid',
        borderColor: alpha(theme.palette.secondary.main, 0.3),
        borderRadius: 1.5,
        bgcolor: alpha(theme.palette.secondary.main, 0.04),
      })}
    >
      {/* Header */}
      <Box
        sx={(theme) => ({
          display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75,
          cursor: 'pointer', borderRadius: 1.5, transition: 'background-color 0.2s ease',
          '&:hover': { bgcolor: alpha(theme.palette.secondary.main, 0.1) },
        })}
        onClick={() => {
          if (expandAll) return;
          setExpanded((prev) => !prev);
        }}
      >
        <SmartToyOutlined sx={(theme) => ({ fontSize: 18, color: theme.palette.secondary.main })} />
        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 500, fontSize: '0.9rem', color: 'text.secondary' }}>
          Claude Code
        </Typography>
        {statParts.length > 0 && (
          <Chip
            label={statParts.join(' · ')}
            size="small"
            variant="outlined"
            sx={{ fontSize: '0.7rem', height: 20 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        <CopyButton text={content} variant="icon" size="small" tooltip="Copy session" />
        <IconButton size="small" sx={{ p: 0.25 }}>
          {isExpanded ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
        </IconButton>
      </Box>

      {/* Session content */}
      <Collapse in={isExpanded}>
        <Box sx={{ mx: 1.5, mb: 1.5, maxHeight: 600, overflow: 'auto', p: 1.5 }}>
          <ClaudeCodeSession content={content} />
        </Box>
      </Collapse>
    </Box>
  );
}

export default memo(ClaudeCodeItem);
