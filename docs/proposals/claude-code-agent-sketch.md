# Claude Code Agent — Delegate Tasks to Claude Code

**Status:** Draft — sketch in progress, see [claude-code-agent-questions.md](claude-code-agent-questions.md)

## Problem

TARSy's current agent execution model is a Go-controlled loop: the `IteratingController` drives every LLM call, routes tool calls through MCP, and manages conversation state. This works well for structured investigation chains but has inherent limitations:

- **Tool surface is MCP-only.** Agents can only use tools exposed by MCP servers. There is no way for an agent to read/write files, run shell commands, search codebases, or perform other developer-workflow actions unless a custom MCP server wraps each capability.
- **The agent loop is rigid.** TARSy controls iteration count, tool routing, and conversation flow. The LLM has no autonomy to decide its own workflow — it must respond within TARSy's turn structure.
- **Complex agentic tasks don't fit.** Some tasks (deep code analysis, multi-file investigation, running test suites, writing remediation scripts) benefit from a fully autonomous agent that can plan, execute, revise, and iterate without external turn management.

Claude Code is Anthropic's agentic coding tool. It runs its own agent loop with built-in tools (file read/write, Bash execution, code search, Git), supports MCP server integration, and can operate non-interactively via the Agent SDK CLI (`claude -p`). It can be containerized for isolation.

## Goal

Add a new agent type to TARSy — `claude_code` — that delegates execution to a Claude Code instance instead of running through the internal LLM + tool loop. The Go orchestrator retains lifecycle control (timeouts, cancellation, status tracking) while Claude Code handles the agentic work autonomously.

## How It Relates to Existing Architecture

The Claude Code agent fits into TARSy's existing framework the same way other agent types do — as a new `AgentType` with a dedicated `Controller`:

```
AgentFactory.CreateAgent(execCtx)
    → ControllerFactory.CreateController(AgentTypeClaudeCode, execCtx)
        → ClaudeCodeController{}
            → BaseAgent wraps it (DB status tracking, lifecycle)
```

The key difference: instead of `IteratingController.Run()` calling `LLMClient.Generate()` in a loop, `ClaudeCodeController.Run()` sends an HTTP request to the Claude Code sidecar and streams NDJSON events back.

```
Existing agents:                    Claude Code agent:
┌──────────────────────┐            ┌──────────────────────┐
│  IteratingController │            │ ClaudeCodeController │
│                      │            │                      │
│  for each iteration: │            │  HTTP POST to sidecar│
│    LLMClient.Generate│            │  read NDJSON stream  │
│    ToolExecutor.Exec │            │  map events → TARSy  │
│    store in DB       │            │  store in DB         │
│                      │            │  wait for completion │
└──────────────────────┘            └──────────────────────┘
         │                                    │
    Python LLM Service              TypeScript sidecar
      (gRPC)                     (HTTP + NDJSON streaming)
                                  ┌──────────────────────┐
                                  │ @anthropic-ai/       │
                                  │ claude-agent-sdk     │
                                  │                      │
                                  │ query() → stream     │
                                  │ Built-in tools       │
                                  │ MCP support          │
                                  └──────────────────────┘
```

**Deployment model:**
- **Dev (`make dev`):** Standalone TypeScript service running locally
- **Containerized (dev & prod):** Sidecar container — isolated from TARSy's container

The sidecar wraps the official `@anthropic-ai/claude-agent-sdk` TypeScript SDK, exposing an HTTP endpoint. TARSy sends an HTTP POST with the prompt and configuration, and reads back an NDJSON stream of events. This aligns with Anthropic's hosting guidance for container-based SDK deployments.

### What stays the same

- `BaseAgent` wraps the controller (execution status tracking, DB lifecycle)
- `AgentFactory` creates it from `ExecutionContext`
- Session executor creates `AgentExecution` DB records, wires up event publishing
- Timeline events stream to the dashboard via WebSocket
- The agent is configurable via `tarsy.yaml` like any other agent
- It can participate in chains (stages, synthesis after parallel agents)
- It can be dispatched as an orchestrator sub-agent

### What changes

- No `LLMClient` usage — Claude Code calls the Anthropic API directly
- No `ToolExecutor` usage — Claude Code has its own tools (Bash, Read, Edit, Grep, Glob) and can connect to MCP servers independently
- The Python LLM Service is bypassed entirely for this agent type
- A new streaming bridge maps Claude Code's `stream-json` output to TARSy's timeline events

## Key Concepts

### Execution model

The `ClaudeCodeController` spawns Claude Code as an external process:

1. Builds the prompt from alert data, previous stage context, and custom instructions
2. Constructs CLI flags: `--bare`, `--output-format stream-json`, `--allowedTools`, `--mcp-config`, `--append-system-prompt`
3. Spawns the process (directly or inside a container)
4. Reads stdout line-by-line (NDJSON stream)
5. Maps events to TARSy timeline events and publishes them via WebSocket
6. On process exit, extracts the final result and token usage

> **Open question:** subprocess vs container isolation — see [questions document](claude-code-agent-questions.md), Q2.

### Event mapping

Claude Code's `stream-json` output produces events that map to TARSy's existing timeline event types:

| Claude Code event | TARSy timeline event | Notes |
|---|---|---|
| `text_delta` | `StreamChunkPayload` | Streaming text to dashboard |
| Tool use (Bash, Read, etc.) | `tool_call` timeline event | Claude Code's built-in tools |
| Tool result | `tool_result` timeline event | Tool output |
| `thinking` | `thinking` timeline event | Extended thinking blocks |
| `result` (final) | `FinalAnalysis` + completion | Session result |

> **Open question:** streaming granularity and dashboard rendering — see [questions document](claude-code-agent-questions.md), Q4.

### Tool access

Claude Code comes with built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, and more. Additionally, it supports MCP servers via `--mcp-config`.

For TARSy's use case, this means a Claude Code agent could:
- Run `kubectl` commands directly via Bash (instead of routing through a kubernetes MCP server)
- Read log files, configuration files, or codebases from a mounted workspace
- Connect to the same MCP servers other TARSy agents use

> **Open question:** tool access model — see [questions document](claude-code-agent-questions.md), Q3.

### Authentication

Claude Code requires an `ANTHROPIC_API_KEY` (or Bedrock/Vertex credentials). This is separate from any LLM provider configuration in TARSy's `llm-providers.yaml` — Claude Code manages its own API authentication.

> **Open question:** how to manage the Anthropic API key — see [questions document](claude-code-agent-questions.md), Q5.

### Cost and budget control

Claude Code can autonomously make many LLM calls. Cost control mechanisms:
- `--max-turns` CLI flag limits the number of agent loop cycles
- `--max-tokens` limits per-call output
- Context timeout from TARSy's session/execution timeout
- The final `result` JSON includes `total_cost_usd` and token usage for tracking

### Configuration

A Claude Code agent would be configured in `tarsy.yaml` like any other agent, with claude-code-specific fields:

```yaml
agents:
  ClaudeCodeInvestigator:
    type: claude_code
    description: >
      Investigates incidents using Claude Code with full shell access,
      file system tools, and MCP server integration.
    custom_instructions: |
      You are an SRE investigating a Kubernetes incident.
      Use kubectl, log files, and available MCP tools to investigate.
    claude_code:
      max_turns: 30
      allowed_tools: ["Bash", "Read", "Grep", "Glob"]
      mcp_config: "/etc/tarsy/claude-mcp.json"
```

## Use Cases

### Primary: Deep investigation with shell/file access

Alerts that require running commands, reading logs, analyzing config files, or performing multi-step diagnosis that the current MCP-only tool surface can't handle well.

### Secondary: Orchestrator sub-agent

The orchestrator dispatches a Claude Code agent for tasks that benefit from autonomous exploration — "investigate why pods are OOMKilling by checking memory limits, recent deployments, and node resource usage."

### Future: Remediation with code generation

Action stages where Claude Code writes and applies remediation scripts, Kubernetes manifests, or configuration changes — with container isolation for safety.

## What Is Out of Scope

- **Replacing existing agents** — Claude Code is an additional agent type, not a replacement for existing investigation/synthesis/scoring agents
- **Interactive Claude Code sessions** — only headless/programmatic execution via `-p` flag
- **Claude Code on the web** (Anthropic's hosted version) — TARSy runs its own Claude Code instances
- **Multi-model routing within Claude Code** — Claude Code uses Anthropic models only; TARSy's multi-provider system handles other models via existing agent types
- **Custom tool development for Claude Code** — using Claude Code's built-in tools and standard MCP, not building custom SDK tools
- **Dashboard redesign** — initial version maps Claude Code events to existing timeline event types; dedicated UI components can follow later
