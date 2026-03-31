package controller

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/codeready-toolchain/tarsy/ent/timelineevent"
	"github.com/codeready-toolchain/tarsy/pkg/agent"
	"github.com/codeready-toolchain/tarsy/pkg/events"
	"github.com/codeready-toolchain/tarsy/pkg/models"
)

const (
	defaultSidecarURL = "http://localhost:3100"
	sidecarEnvVar     = "CLAUDE_CODE_SIDECAR_URL"
	maxToolOutput     = 4000
)

// ClaudeCodeController delegates execution to a Claude Code sidecar service.
// Instead of running the internal LLM + tool loop, it sends a prompt to
// the sidecar over HTTP and streams back NDJSON events, rendering the entire
// CC session as a single streaming timeline event.
type ClaudeCodeController struct {
	sidecarURL string
	httpClient *http.Client
}

// NewClaudeCodeController creates a controller that talks to the CC sidecar.
func NewClaudeCodeController() *ClaudeCodeController {
	url := os.Getenv(sidecarEnvVar)
	if url == "" {
		url = defaultSidecarURL
	}
	return &ClaudeCodeController{
		sidecarURL: url,
		httpClient: &http.Client{},
	}
}

// SidecarRequest is the JSON payload sent to the CC sidecar's /query endpoint.
type SidecarRequest struct {
	Prompt         string            `json:"prompt"`
	SystemPrompt   string            `json:"system_prompt,omitempty"`
	MaxTurns       int               `json:"max_turns,omitempty"`
	AllowedTools   []string          `json:"allowed_tools,omitempty"`
	SettingSources []string          `json:"setting_sources,omitempty"`
	WorkspaceDir   string            `json:"workspace_dir,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
}

// sidecarEvent represents a single NDJSON event from the CC sidecar.
type sidecarEvent struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype,omitempty"`

	Result       string          `json:"result,omitempty"`
	IsError      bool            `json:"is_error,omitempty"`
	DurationMS   int             `json:"duration_ms,omitempty"`
	NumTurns     int             `json:"num_turns,omitempty"`
	TotalCostUSD float64         `json:"total_cost_usd,omitempty"`
	Usage        *sidecarUsage   `json:"usage,omitempty"`
	Errors       []string        `json:"errors,omitempty"`
	StopReason   *string         `json:"stop_reason,omitempty"`
	Raw          json.RawMessage `json:"-"`
}

type sidecarUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// Run implements agent.Controller.
func (c *ClaudeCodeController) Run(
	ctx context.Context,
	execCtx *agent.ExecutionContext,
	prevStageContext string,
) (*agent.ExecutionResult, error) {
	logger := slog.With(
		"session_id", execCtx.SessionID,
		"execution_id", execCtx.ExecutionID,
		"agent", execCtx.AgentName,
	)

	eventSeq, seqErr := execCtx.Services.Timeline.GetMaxSequenceForExecution(ctx, execCtx.ExecutionID)
	if seqErr != nil {
		slog.Warn("Failed to get max sequence for execution, starting from 0",
			"execution_id", execCtx.ExecutionID, "error", seqErr)
	}

	prompt := buildClaudeCodePrompt(execCtx, prevStageContext)
	systemPrompt := buildClaudeCodeSystemPrompt(execCtx)

	req := c.buildSidecarRequest(execCtx, prompt, systemPrompt)

	resp, err := c.sendRequest(ctx, req)
	if err != nil {
		logger.Error("Failed to send request to CC sidecar", "error", err)
		return &agent.ExecutionResult{
			Status: agent.StatusFromErr(err),
			Error:  fmt.Errorf("CC sidecar request failed: %w", err),
		}, nil
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		err := fmt.Errorf("CC sidecar returned %d: %s", resp.StatusCode, string(body))
		logger.Error("CC sidecar error response", "status", resp.StatusCode, "body", string(body))
		return &agent.ExecutionResult{
			Status: agent.ExecutionStatusFailed,
			Error:  err,
		}, nil
	}

	result, streamErr := c.streamSession(ctx, execCtx, resp.Body, &eventSeq, logger)
	if streamErr != nil {
		if ctx.Err() != nil {
			return &agent.ExecutionResult{
				Status: agent.StatusFromErr(ctx.Err()),
				Error:  ctx.Err(),
			}, nil
		}
		logger.Error("Error streaming CC session", "error", streamErr)
		return &agent.ExecutionResult{
			Status: agent.ExecutionStatusFailed,
			Error:  fmt.Errorf("CC stream error: %w", streamErr),
		}, nil
	}

	if result.FinalAnalysis != "" {
		createTimelineEvent(ctx, execCtx, timelineevent.EventTypeFinalAnalysis,
			result.FinalAnalysis, nil, &eventSeq)
	}

	return result, nil
}

// streamSession reads the entire NDJSON stream from the sidecar, formatting it
// as terminal-like text into a single streaming timeline event.
func (c *ClaudeCodeController) streamSession(
	ctx context.Context,
	execCtx *agent.ExecutionContext,
	body io.Reader,
	eventSeq *int,
	logger *slog.Logger,
) (*agent.ExecutionResult, error) {
	*eventSeq++

	// Create one streaming timeline event for the whole CC session.
	tlEvent, err := execCtx.Services.Timeline.CreateTimelineEvent(ctx, models.CreateTimelineEventRequest{
		SessionID:         execCtx.SessionID,
		StageID:           &execCtx.StageID,
		ExecutionID:       &execCtx.ExecutionID,
		ParentExecutionID: parentExecIDPtr(execCtx),
		SequenceNumber:    *eventSeq,
		EventType:         timelineevent.EventTypeClaudeCode,
		Content:           "",
		Metadata:          map[string]interface{}{"cc_type": "session"},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create CC timeline event: %w", err)
	}

	// Publish the streaming event so the dashboard shows it immediately.
	if execCtx.EventPublisher != nil {
		_ = execCtx.EventPublisher.PublishTimelineCreated(ctx, execCtx.SessionID, events.TimelineCreatedPayload{
			BasePayload: events.BasePayload{
				Type:      events.EventTypeTimelineCreated,
				SessionID: execCtx.SessionID,
				Timestamp: tlEvent.CreatedAt.Format(time.RFC3339Nano),
			},
			EventID:           tlEvent.ID,
			StageID:           execCtx.StageID,
			ExecutionID:       execCtx.ExecutionID,
			ParentExecutionID: parentExecID(execCtx),
			EventType:         timelineevent.EventTypeClaudeCode,
			Status:            timelineevent.StatusStreaming,
			Content:           "",
			Metadata:          map[string]interface{}{"cc_type": "session"},
			SequenceNumber:    *eventSeq,
		})
	}

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024)

	var (
		result     *agent.ExecutionResult
		totalUsage agent.TokenUsage
		textBuf    strings.Builder
	)

	for scanner.Scan() {
		if ctx.Err() != nil {
			c.failEvent(ctx, execCtx, tlEvent.ID, textBuf.String())
			return nil, ctx.Err()
		}

		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}

		var event sidecarEvent
		if err := json.Unmarshal(line, &event); err != nil {
			logger.Warn("Failed to parse CC NDJSON line", "error", err, "line", string(line))
			continue
		}
		event.Raw = json.RawMessage(make([]byte, len(line)))
		copy(event.Raw, line)

		if event.Type == "result" {
			result = c.extractResult(&event, &totalUsage)
			continue
		}

		if event.Type == "assistant" && event.Usage != nil {
			totalUsage.InputTokens += event.Usage.InputTokens
			totalUsage.OutputTokens += event.Usage.OutputTokens
			totalUsage.TotalTokens += event.Usage.InputTokens + event.Usage.OutputTokens
		}

		delta := formatEventText(&event)
		if delta == "" {
			continue
		}

		textBuf.WriteString(delta)
		c.publishChunk(ctx, execCtx, tlEvent.ID, delta)
	}

	if err := scanner.Err(); err != nil {
		c.failEvent(ctx, execCtx, tlEvent.ID, textBuf.String())
		return nil, fmt.Errorf("reading CC stream: %w", err)
	}

	// Finalize the streaming event.
	content := textBuf.String()
	if content == "" {
		content = "(no output)"
	}

	resultMeta := map[string]interface{}{"cc_type": "session"}
	if result != nil {
		resultMeta["num_turns"] = result.TokensUsed.TotalTokens // overwritten below if available
		if event := c.resultMeta(result); event != nil {
			for k, v := range event {
				resultMeta[k] = v
			}
		}
	}

	if err := execCtx.Services.Timeline.CompleteTimelineEventWithMetadata(
		ctx, tlEvent.ID, content, resultMeta, nil, nil,
	); err != nil {
		slog.Warn("Failed to complete CC session event", "event_id", tlEvent.ID, "error", err)
	}

	if execCtx.EventPublisher != nil {
		_ = execCtx.EventPublisher.PublishTimelineCompleted(ctx, execCtx.SessionID, events.TimelineCompletedPayload{
			BasePayload: events.BasePayload{
				Type:      events.EventTypeTimelineCompleted,
				SessionID: execCtx.SessionID,
				Timestamp: time.Now().Format(time.RFC3339Nano),
			},
			EventID:           tlEvent.ID,
			ParentExecutionID: parentExecID(execCtx),
			EventType:         timelineevent.EventTypeClaudeCode,
			Content:           content,
			Status:            timelineevent.StatusCompleted,
			Metadata:          resultMeta,
		})
	}

	if result == nil {
		return &agent.ExecutionResult{
			Status:     agent.ExecutionStatusFailed,
			Error:      fmt.Errorf("CC sidecar stream ended without a result event"),
			TokensUsed: totalUsage,
		}, nil
	}

	return result, nil
}

func (c *ClaudeCodeController) publishChunk(ctx context.Context, execCtx *agent.ExecutionContext, eventID, delta string) {
	if execCtx.EventPublisher == nil || delta == "" {
		return
	}
	_ = execCtx.EventPublisher.PublishStreamChunk(ctx, execCtx.SessionID, events.StreamChunkPayload{
		BasePayload: events.BasePayload{
			Type:      events.EventTypeStreamChunk,
			SessionID: execCtx.SessionID,
			Timestamp: time.Now().Format(time.RFC3339Nano),
		},
		EventID:           eventID,
		ParentExecutionID: parentExecID(execCtx),
		Delta:             delta,
	})
}

func (c *ClaudeCodeController) failEvent(ctx context.Context, execCtx *agent.ExecutionContext, eventID, content string) {
	if content == "" {
		content = "(cancelled)"
	}
	_ = execCtx.Services.Timeline.FailTimelineEvent(ctx, eventID, content)
	if execCtx.EventPublisher != nil {
		_ = execCtx.EventPublisher.PublishTimelineCompleted(ctx, execCtx.SessionID, events.TimelineCompletedPayload{
			BasePayload: events.BasePayload{
				Type:      events.EventTypeTimelineCompleted,
				SessionID: execCtx.SessionID,
				Timestamp: time.Now().Format(time.RFC3339Nano),
			},
			EventID:           eventID,
			ParentExecutionID: parentExecID(execCtx),
			EventType:         timelineevent.EventTypeClaudeCode,
			Content:           content,
			Status:            timelineevent.StatusFailed,
		})
	}
}

func (c *ClaudeCodeController) resultMeta(result *agent.ExecutionResult) map[string]interface{} {
	return map[string]interface{}{
		"input_tokens":  result.TokensUsed.InputTokens,
		"output_tokens": result.TokensUsed.OutputTokens,
	}
}

// ---------------------------------------------------------------------------
// Text formatting — renders SDK events as terminal-like output
// ---------------------------------------------------------------------------

func formatEventText(event *sidecarEvent) string {
	switch event.Type {
	case "assistant":
		return formatAssistant(event.Raw)
	case "user":
		return formatUser(event.Raw)
	case "system":
		return ""
	default:
		return ""
	}
}

func formatAssistant(raw json.RawMessage) string {
	blocks := parseContentBlocks(raw)
	if len(blocks) == 0 {
		return ""
	}

	var sb strings.Builder
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if b.Text != "" {
				sb.WriteString(b.Text)
				sb.WriteString("\n\n")
			}
		case "tool_use":
			sb.WriteString(fmtToolCall(b.Name, b.Input))
		}
	}
	return sb.String()
}

func formatUser(raw json.RawMessage) string {
	blocks := parseContentBlocks(raw)
	if len(blocks) == 0 {
		return ""
	}

	var sb strings.Builder
	for _, b := range blocks {
		if b.Type != "tool_result" {
			continue
		}
		text := extractToolResultText(b.Content)
		if text == "" {
			continue
		}
		if len(text) > maxToolOutput {
			text = text[:maxToolOutput] + "\n…(truncated)"
		}
		sb.WriteString(text)
		sb.WriteString("\n\n")
	}
	return sb.String()
}

type contentBlock struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	Name    string          `json:"name"`
	Input   json.RawMessage `json:"input"`
	Content json.RawMessage `json:"content"`
}

func parseContentBlocks(raw json.RawMessage) []contentBlock {
	var msg struct {
		Message struct {
			Content []contentBlock `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil
	}
	return msg.Message.Content
}

func fmtToolCall(name string, input json.RawMessage) string {
	var sb strings.Builder
	sb.WriteString("❯ ")
	sb.WriteString(name)

	if len(input) > 0 {
		var m map[string]interface{}
		if err := json.Unmarshal(input, &m); err == nil {
			if cmd, ok := m["command"].(string); ok {
				sb.WriteString(": ")
				sb.WriteString(cmd)
				sb.WriteString("\n")
				return sb.String()
			}
			if fp, ok := m["file_path"].(string); ok {
				sb.WriteString(": ")
				sb.WriteString(fp)
				sb.WriteString("\n")
				return sb.String()
			}
			if p, ok := m["pattern"].(string); ok {
				sb.WriteString(": ")
				sb.WriteString(p)
				sb.WriteString("\n")
				return sb.String()
			}
		}
	}

	sb.WriteString("\n")
	return sb.String()
}

func extractToolResultText(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(content, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// ---------------------------------------------------------------------------
// Request building & misc
// ---------------------------------------------------------------------------

func (c *ClaudeCodeController) buildSidecarRequest(execCtx *agent.ExecutionContext, prompt, systemPrompt string) SidecarRequest {
	req := SidecarRequest{
		Prompt:       prompt,
		SystemPrompt: systemPrompt,
	}
	if cc := execCtx.Config.ClaudeCode; cc != nil {
		if cc.MaxTurns != nil {
			req.MaxTurns = *cc.MaxTurns
		}
		req.AllowedTools = cc.AllowedTools
		req.SettingSources = cc.SettingSources
		req.WorkspaceDir = resolveWorkspaceDir(cc.WorkspaceDir)
	}
	return req
}

func resolveWorkspaceDir(dir string) string {
	if dir == "" || filepath.IsAbs(dir) {
		return dir
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return dir
	}
	return abs
}

func (c *ClaudeCodeController) sendRequest(ctx context.Context, sidecarReq SidecarRequest) (*http.Response, error) {
	body, err := json.Marshal(sidecarReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal sidecar request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sidecarURL+"/query", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create HTTP request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	return c.httpClient.Do(httpReq)
}

func (c *ClaudeCodeController) extractResult(event *sidecarEvent, totalUsage *agent.TokenUsage) *agent.ExecutionResult {
	if event.Usage != nil {
		totalUsage.InputTokens = event.Usage.InputTokens
		totalUsage.OutputTokens = event.Usage.OutputTokens
		totalUsage.TotalTokens = event.Usage.InputTokens + event.Usage.OutputTokens
	}

	status := agent.ExecutionStatusCompleted
	var resultErr error
	if event.IsError || event.Subtype != "success" {
		status = agent.ExecutionStatusFailed
		if len(event.Errors) > 0 {
			resultErr = fmt.Errorf("CC execution failed: %s", strings.Join(event.Errors, "; "))
		} else {
			resultErr = fmt.Errorf("CC execution failed (subtype: %s)", event.Subtype)
		}
	}

	return &agent.ExecutionResult{
		Status:        status,
		FinalAnalysis: event.Result,
		Error:         resultErr,
		TokensUsed:    *totalUsage,
	}
}

func buildClaudeCodePrompt(execCtx *agent.ExecutionContext, prevStageContext string) string {
	var sb strings.Builder

	if execCtx.AlertData != "" {
		sb.WriteString("## Alert Data\n\n")
		sb.WriteString(execCtx.AlertData)
		sb.WriteString("\n\n")
	}

	if prevStageContext != "" {
		sb.WriteString("## Previous Stage Context\n\n")
		sb.WriteString(prevStageContext)
		sb.WriteString("\n\n")
	}

	if execCtx.RunbookContent != "" {
		sb.WriteString("## Runbook\n\n")
		sb.WriteString(execCtx.RunbookContent)
		sb.WriteString("\n\n")
	}

	sb.WriteString("Investigate the alert above and provide a detailed analysis.")
	return sb.String()
}

func buildClaudeCodeSystemPrompt(execCtx *agent.ExecutionContext) string {
	var sb strings.Builder
	sb.WriteString("You are an SRE agent investigating an incident.\n")

	if execCtx.Config.CustomInstructions != "" {
		sb.WriteString("\n")
		sb.WriteString(execCtx.Config.CustomInstructions)
	}

	if execCtx.AlertType != "" {
		sb.WriteString("\nAlert type: ")
		sb.WriteString(execCtx.AlertType)
		sb.WriteString("\n")
	}

	return sb.String()
}

var _ agent.Controller = (*ClaudeCodeController)(nil)
