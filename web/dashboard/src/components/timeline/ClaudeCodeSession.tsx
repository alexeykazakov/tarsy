import { useMemo, useState, memo } from 'react';
import { Box, Typography, IconButton, alpha } from '@mui/material';
import { ExpandMore, ExpandLess, Terminal } from '@mui/icons-material';
import ReactMarkdown from 'react-markdown';
import { finalAnswerMarkdownComponents, remarkPlugins } from '../../utils/markdownComponents';

// Typed chunk emitted by the Go controller as NDJSON lines.
interface CCChunk {
  t: string;  // "text" | "tool" | "result" | "summary" | "system"
  c?: string; // content
  n?: string; // tool name
  in?: string; // tool input summary
}

function parseChunks(content: string): CCChunk[] | null {
  if (!content || !content.startsWith('{')) return null;
  try {
    const chunks: CCChunk[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      chunks.push(JSON.parse(trimmed));
    }
    return chunks.length > 0 ? chunks : null;
  } catch {
    return null;
  }
}

interface ClaudeCodeSessionProps {
  content: string;
  streaming?: boolean;
}

const RESULT_VISIBLE_LINES = 20;

const ToolResultBlock = memo(({ content }: { content: string }) => {
  const lines = content.split('\n');
  const needsTruncation = lines.length > RESULT_VISIBLE_LINES;
  const [expanded, setExpanded] = useState(false);

  const visibleContent = needsTruncation && !expanded
    ? lines.slice(0, RESULT_VISIBLE_LINES).join('\n') + '\n...'
    : content;

  return (
    <Box sx={{ my: 0.5 }}>
      <Box
        sx={(theme) => ({
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          fontSize: '0.8rem',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          p: 1,
          borderRadius: 0.5,
          bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
          color: 'text.secondary',
          borderLeft: `2px solid ${alpha(theme.palette.divider, 0.5)}`,
          maxHeight: expanded ? 'none' : 300,
          overflow: expanded ? 'visible' : 'auto',
        })}
      >
        {visibleContent}
      </Box>
      {needsTruncation && (
        <Typography
          variant="caption"
          onClick={() => setExpanded(!expanded)}
          sx={{
            cursor: 'pointer',
            color: 'primary.main',
            ml: 1,
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          {expanded ? 'show less' : `show all ${lines.length} lines`}
        </Typography>
      )}
    </Box>
  );
});

ToolResultBlock.displayName = 'ToolResultBlock';

const ToolCallBlock = memo(({ name, input }: { name: string; input?: string }) => {
  const [expanded, setExpanded] = useState(true);

  return (
    <Box sx={{ my: 0.75 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Terminal sx={{ fontSize: 14, color: 'primary.main' }} />
        <Typography
          variant="body2"
          sx={{
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            fontWeight: 600,
            fontSize: '0.85rem',
            color: 'primary.main',
          }}
        >
          {name}
        </Typography>
        {input && (
          <Typography
            variant="body2"
            sx={{
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
              fontSize: '0.8rem',
              color: 'text.secondary',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {input}
          </Typography>
        )}
        <IconButton size="small" sx={{ p: 0, ml: 'auto' }}>
          {expanded ? <ExpandLess sx={{ fontSize: 16 }} /> : <ExpandMore sx={{ fontSize: 16 }} />}
        </IconButton>
      </Box>
    </Box>
  );
});

ToolCallBlock.displayName = 'ToolCallBlock';

function ClaudeCodeSession({ content, streaming = false }: ClaudeCodeSessionProps) {
  const chunks = useMemo(() => parseChunks(content), [content]);

  if (!chunks) {
    return (
      <Box
        sx={(theme) => ({
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          fontSize: '0.82rem',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: theme.palette.mode === 'dark' ? 'grey.300' : 'text.primary',
        })}
      >
        {content || (streaming ? 'Starting session...' : '(no output)')}
      </Box>
    );
  }

  return (
    <Box>
      {chunks.map((chunk, i) => {
        const key = `${chunk.t}-${i}`;
        const isLastChunk = i === chunks.length - 1;

        switch (chunk.t) {
          case 'text':
            return (
              <Box key={key} sx={{ my: 0.5 }}>
                <Box sx={{
                  '& > :first-of-type': { mt: 0 },
                  '& > :last-child': { mb: 0 },
                }}>
                  <ReactMarkdown
                    components={finalAnswerMarkdownComponents}
                    remarkPlugins={remarkPlugins}
                    skipHtml
                  >
                    {chunk.c || ''}
                  </ReactMarkdown>
                </Box>
                {streaming && isLastChunk && (
                  <Box
                    component="span"
                    sx={{
                      display: 'inline-block',
                      width: 8,
                      height: 16,
                      bgcolor: 'primary.main',
                      ml: 0.5,
                      verticalAlign: 'text-bottom',
                      animation: 'blink 1s step-end infinite',
                      '@keyframes blink': {
                        '0%, 100%': { opacity: 1 },
                        '50%': { opacity: 0 },
                      },
                    }}
                  />
                )}
              </Box>
            );

          case 'tool':
            return <ToolCallBlock key={key} name={chunk.n || 'Tool'} input={chunk.in} />;

          case 'result':
            return <ToolResultBlock key={key} content={chunk.c || ''} />;

          case 'summary':
            return (
              <Typography
                key={key}
                variant="body2"
                sx={{
                  my: 0.5,
                  fontSize: '0.8rem',
                  fontStyle: 'italic',
                  color: 'text.disabled',
                }}
              >
                {chunk.c}
              </Typography>
            );

          case 'system':
            return (
              <Box
                key={key}
                sx={(theme) => ({
                  display: 'inline-block',
                  my: 0.5,
                  px: 1,
                  py: 0.25,
                  borderRadius: 0.5,
                  fontSize: '0.72rem',
                  fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                  color: 'text.disabled',
                  bgcolor: alpha(theme.palette.divider, 0.3),
                })}
              >
                {chunk.c}
              </Box>
            );

          default:
            return null;
        }
      })}
    </Box>
  );
}

export default memo(ClaudeCodeSession);
