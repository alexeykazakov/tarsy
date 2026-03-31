package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codeready-toolchain/tarsy/ent/timelineevent"
	"github.com/codeready-toolchain/tarsy/pkg/agent"
	"github.com/codeready-toolchain/tarsy/pkg/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newClaudeCodeExecCtx(t *testing.T) *agent.ExecutionContext {
	t.Helper()
	maxTurns := 10
	execCtx := newTestExecCtx(t, nil, nil)
	execCtx.Config.Type = config.AgentTypeClaudeCode
	execCtx.Config.ClaudeCode = &config.ClaudeCodeConfig{
		MaxTurns:       &maxTurns,
		AllowedTools:   []string{"Bash", "Read"},
		SettingSources: []string{"project"},
		WorkspaceDir:   "/tmp/workspace",
	}
	return execCtx
}

func ndjsonLines(events ...interface{}) string {
	var sb strings.Builder
	for _, e := range events {
		b, _ := json.Marshal(e)
		sb.Write(b)
		sb.WriteByte('\n')
	}
	return sb.String()
}

func TestClaudeCodeController_SuccessfulExecution(t *testing.T) {
	body := ndjsonLines(
		map[string]interface{}{
			"type": "system", "subtype": "init",
			"uuid": "sys-1", "session_id": "s1",
		},
		map[string]interface{}{
			"type": "assistant", "uuid": "a-1", "session_id": "s1",
			"message": map[string]interface{}{
				"content": []map[string]interface{}{
					{"type": "text", "text": "Investigating the alert..."},
				},
			},
		},
		map[string]interface{}{
			"type": "assistant", "uuid": "a-2", "session_id": "s1",
			"message": map[string]interface{}{
				"content": []map[string]interface{}{
					{"type": "tool_use", "id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "kubectl get pods"}},
				},
			},
		},
		map[string]interface{}{
			"type": "user", "uuid": "u-1", "session_id": "s1",
			"message": map[string]interface{}{
				"content": []map[string]interface{}{
					{"type": "tool_result", "tool_use_id": "t1", "content": "pod-xyz   1/1   Running   0   5m"},
				},
			},
		},
		map[string]interface{}{
			"type": "result", "subtype": "success",
			"uuid": "r-1", "session_id": "s1",
			"result": "Root cause: OOM in pod-xyz", "is_error": false,
			"num_turns": 3, "total_cost_usd": 0.05, "duration_ms": 12000,
			"usage": map[string]int{"input_tokens": 1000, "output_tokens": 500},
		},
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/query", r.URL.Path)
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))

		var req SidecarRequest
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		assert.Contains(t, req.Prompt, "Test alert")
		assert.Equal(t, 10, req.MaxTurns)
		assert.Equal(t, []string{"Bash", "Read"}, req.AllowedTools)

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, body)
	}))
	defer srv.Close()

	ctrl := &ClaudeCodeController{
		sidecarURL: srv.URL,
		httpClient: srv.Client(),
	}

	execCtx := newClaudeCodeExecCtx(t)
	result, err := ctrl.Run(context.Background(), execCtx, "")
	require.NoError(t, err)
	require.NotNil(t, result)

	assert.Equal(t, agent.ExecutionStatusCompleted, result.Status)
	assert.Equal(t, "Root cause: OOM in pod-xyz", result.FinalAnalysis)
	assert.Nil(t, result.Error)
	assert.Equal(t, 1000, result.TokensUsed.InputTokens)
	assert.Equal(t, 500, result.TokensUsed.OutputTokens)

	// Should have exactly 1 claude_code event (the session) + 1 final_analysis.
	events, queryErr := execCtx.Services.Timeline.GetSessionTimeline(context.Background(), execCtx.SessionID)
	require.NoError(t, queryErr)

	var ccEvents, faEvents int
	var ccContent string
	for _, e := range events {
		switch e.EventType {
		case timelineevent.EventTypeClaudeCode:
			ccEvents++
			ccContent = e.Content
			assert.Equal(t, timelineevent.StatusCompleted, e.Status)
		case timelineevent.EventTypeFinalAnalysis:
			faEvents++
		}
	}
	assert.Equal(t, 1, ccEvents, "expected exactly 1 claude_code session event")
	assert.Equal(t, 1, faEvents, "expected 1 final_analysis event")

	// The session content should contain the assistant text and tool call.
	assert.Contains(t, ccContent, "Investigating the alert...")
	assert.Contains(t, ccContent, "❯ Bash: kubectl get pods")
	assert.Contains(t, ccContent, "pod-xyz")
}

func TestClaudeCodeController_ErrorResult(t *testing.T) {
	body := ndjsonLines(
		map[string]interface{}{
			"type": "result", "subtype": "error_max_turns",
			"uuid": "r-1", "session_id": "s1",
			"result": "", "is_error": true,
			"num_turns": 50, "total_cost_usd": 1.0, "duration_ms": 60000,
			"usage":  map[string]int{"input_tokens": 5000, "output_tokens": 2000},
			"errors": []string{"max turns reached"},
		},
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, body)
	}))
	defer srv.Close()

	ctrl := &ClaudeCodeController{
		sidecarURL: srv.URL,
		httpClient: srv.Client(),
	}

	execCtx := newClaudeCodeExecCtx(t)
	result, err := ctrl.Run(context.Background(), execCtx, "")
	require.NoError(t, err)
	require.NotNil(t, result)

	assert.Equal(t, agent.ExecutionStatusFailed, result.Status)
	assert.NotNil(t, result.Error)
	assert.Contains(t, result.Error.Error(), "max turns reached")
}

func TestClaudeCodeController_SidecarDown(t *testing.T) {
	ctrl := &ClaudeCodeController{
		sidecarURL: "http://127.0.0.1:1",
		httpClient: &http.Client{},
	}

	execCtx := newClaudeCodeExecCtx(t)
	result, err := ctrl.Run(context.Background(), execCtx, "")
	require.NoError(t, err)
	require.NotNil(t, result)

	assert.Equal(t, agent.ExecutionStatusFailed, result.Status)
	assert.NotNil(t, result.Error)
	assert.Contains(t, result.Error.Error(), "CC sidecar request failed")
}

func TestClaudeCodeController_SidecarHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"error":"internal error"}`)
	}))
	defer srv.Close()

	ctrl := &ClaudeCodeController{
		sidecarURL: srv.URL,
		httpClient: srv.Client(),
	}

	execCtx := newClaudeCodeExecCtx(t)
	result, err := ctrl.Run(context.Background(), execCtx, "")
	require.NoError(t, err)
	require.NotNil(t, result)

	assert.Equal(t, agent.ExecutionStatusFailed, result.Status)
	assert.Contains(t, result.Error.Error(), "CC sidecar returned 500")
}

func TestClaudeCodeController_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		b, _ := json.Marshal(map[string]interface{}{"type": "system", "subtype": "init", "uuid": "s1", "session_id": "s1"})
		fmt.Fprintf(w, "%s\n", b)
		w.(http.Flusher).Flush()
		cancel()
		<-ctx.Done()
	}))
	defer srv.Close()

	ctrl := &ClaudeCodeController{
		sidecarURL: srv.URL,
		httpClient: srv.Client(),
	}

	execCtx := newClaudeCodeExecCtx(t)
	result, err := ctrl.Run(ctx, execCtx, "")
	require.NoError(t, err)
	require.NotNil(t, result)

	assert.Equal(t, agent.ExecutionStatusCancelled, result.Status)

	// The streaming event should be marked as failed.
	events, _ := execCtx.Services.Timeline.GetSessionTimeline(context.Background(), execCtx.SessionID)
	for _, e := range events {
		if e.EventType == timelineevent.EventTypeClaudeCode {
			assert.Equal(t, timelineevent.StatusFailed, e.Status)
		}
	}
}

func TestClaudeCodeController_NoResultEvent(t *testing.T) {
	body := ndjsonLines(
		map[string]interface{}{
			"type": "system", "subtype": "init",
			"uuid": "sys-1", "session_id": "s1",
		},
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, body)
	}))
	defer srv.Close()

	ctrl := &ClaudeCodeController{
		sidecarURL: srv.URL,
		httpClient: srv.Client(),
	}

	execCtx := newClaudeCodeExecCtx(t)
	result, err := ctrl.Run(context.Background(), execCtx, "")
	require.NoError(t, err)
	require.NotNil(t, result)

	assert.Equal(t, agent.ExecutionStatusFailed, result.Status)
	assert.Contains(t, result.Error.Error(), "stream ended without a result event")
}

func TestClaudeCodeController_PrevStageContext(t *testing.T) {
	var capturedReq SidecarRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&capturedReq)
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		body := ndjsonLines(map[string]interface{}{
			"type": "result", "subtype": "success",
			"uuid": "r-1", "session_id": "s1",
			"result": "done", "is_error": false, "num_turns": 1,
			"usage": map[string]int{"input_tokens": 10, "output_tokens": 5},
		})
		fmt.Fprint(w, body)
	}))
	defer srv.Close()

	ctrl := &ClaudeCodeController{
		sidecarURL: srv.URL,
		httpClient: srv.Client(),
	}

	execCtx := newClaudeCodeExecCtx(t)
	_, err := ctrl.Run(context.Background(), execCtx, "Previous findings: pod OOMKilled")
	require.NoError(t, err)

	assert.Contains(t, capturedReq.Prompt, "Previous Stage Context")
	assert.Contains(t, capturedReq.Prompt, "Previous findings: pod OOMKilled")
}

func TestFormatEventText(t *testing.T) {
	tests := []struct {
		name     string
		event    sidecarEvent
		contains []string
		empty    bool
	}{
		{
			name:  "system events produce no output",
			event: sidecarEvent{Type: "system", Subtype: "init"},
			empty: true,
		},
		{
			name: "assistant text",
			event: sidecarEvent{
				Type: "assistant",
				Raw:  json.RawMessage(`{"message":{"content":[{"type":"text","text":"Hello world"}]}}`),
			},
			contains: []string{"Hello world"},
		},
		{
			name: "assistant tool_use with command",
			event: sidecarEvent{
				Type: "assistant",
				Raw:  json.RawMessage(`{"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}`),
			},
			contains: []string{"❯ Bash: ls -la"},
		},
		{
			name: "user tool_result",
			event: sidecarEvent{
				Type: "user",
				Raw:  json.RawMessage(`{"message":{"content":[{"type":"tool_result","content":"file1.txt\nfile2.txt"}]}}`),
			},
			contains: []string{"file1.txt", "file2.txt"},
		},
		{
			name: "assistant empty content",
			event: sidecarEvent{
				Type: "assistant",
				Raw:  json.RawMessage(`{"message":{"content":[]}}`),
			},
			empty: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatEventText(&tt.event)
			if tt.empty {
				assert.Empty(t, result)
				return
			}
			for _, s := range tt.contains {
				assert.Contains(t, result, s)
			}
		})
	}
}
