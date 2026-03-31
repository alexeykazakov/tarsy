package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/codeready-toolchain/tarsy/ent/timelineevent"
	"github.com/codeready-toolchain/tarsy/test/e2e/testdata/configs"
)

// fakeCCSidecar starts an httptest.Server that returns a scripted NDJSON stream
// simulating the Claude Code sidecar.
func fakeCCSidecar(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ok"}`)
			return
		}

		require.Equal(t, "/query", r.URL.Path)

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)

		events := []map[string]interface{}{
			{
				"type": "system", "subtype": "init",
				"uuid": "sys-1", "session_id": "s1",
			},
			{
				"type": "assistant", "uuid": "a-1", "session_id": "s1",
				"message": map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "text", "text": "Investigating pod status..."},
					},
				},
			},
			{
				"type": "assistant", "uuid": "a-2", "session_id": "s1",
				"message": map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "tool_use", "id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "kubectl get pods -n production"}},
					},
				},
			},
			{
				"type": "user", "uuid": "u-1", "session_id": "s1",
				"message": map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "tool_result", "tool_use_id": "t1", "content": "pod-xyz   0/1   OOMKilled   3   10m"},
					},
				},
			},
			{
				"type": "assistant", "uuid": "a-3", "session_id": "s1",
				"message": map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "text", "text": "Found root cause: OOM in pod-xyz."},
					},
				},
			},
			{
				"type": "result", "subtype": "success",
				"uuid": "r-1", "session_id": "s1",
				"result":         "Root cause: pod-xyz is OOMKilled due to memory limit of 256Mi being exceeded. Recommend increasing to 512Mi.",
				"is_error":       false,
				"num_turns":      5,
				"total_cost_usd": 0.08,
				"duration_ms":    15000,
				"stop_reason":    "end_turn",
				"usage":          map[string]int{"input_tokens": 2000, "output_tokens": 800},
			},
		}
		for _, evt := range events {
			b, _ := json.Marshal(evt)
			fmt.Fprintf(w, "%s\n", b)
		}
	}))
}

func TestE2E_ClaudeCodeAgent(t *testing.T) {
	sidecar := fakeCCSidecar(t)
	defer sidecar.Close()

	t.Setenv("CLAUDE_CODE_SIDECAR_URL", sidecar.URL)

	llm := NewScriptedLLMClient()

	app := NewTestApp(t,
		WithConfig(configs.Load(t, "claude-code")),
		WithLLMClient(llm),
	)

	resp := app.SubmitAlert(t, "cc-test-alert", "Pod pod-xyz OOMKilled in namespace production")
	sessionID := resp["session_id"].(string)
	require.NotEmpty(t, sessionID)

	app.WaitForSessionStatus(t, sessionID, "completed")

	session := app.GetSession(t, sessionID)
	assert.Equal(t, "completed", session["status"])

	// Should have exactly 1 claude_code session event + 1 final_analysis.
	events, err := app.EntClient.TimelineEvent.Query().
		Where(timelineevent.SessionID(sessionID)).
		Order(timelineevent.BySequenceNumber()).
		All(context.Background())
	require.NoError(t, err)

	var ccCount, faCount int
	var ccContent, finalAnalysisContent string
	for _, evt := range events {
		switch evt.EventType {
		case timelineevent.EventTypeClaudeCode:
			ccCount++
			ccContent = evt.Content
			assert.Equal(t, timelineevent.StatusCompleted, evt.Status)
		case timelineevent.EventTypeFinalAnalysis:
			faCount++
			finalAnalysisContent = evt.Content
		}
	}

	assert.Equal(t, 1, ccCount, "expected exactly 1 claude_code session event")
	assert.Equal(t, 1, faCount, "expected 1 final_analysis event")

	// The single session event contains NDJSON chunks with the conversation.
	assert.Contains(t, ccContent, `"t":"text"`)
	assert.Contains(t, ccContent, "Investigating pod status...")
	assert.Contains(t, ccContent, `"t":"tool"`)
	assert.Contains(t, ccContent, `"n":"Bash"`)
	assert.Contains(t, ccContent, "kubectl get pods -n production")
	assert.Contains(t, ccContent, "OOMKilled")
	assert.Contains(t, ccContent, "Found root cause")

	assert.Contains(t, finalAnalysisContent, "OOMKilled")
	assert.Contains(t, finalAnalysisContent, "512Mi")
}
