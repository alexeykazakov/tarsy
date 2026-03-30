# Claude Code Agent — Delegate Tasks to Claude Code

**Status:** Sketch complete — ready for detailed design

## Problem

TARSy's current agent execution model is a Go-controlled loop: the `IteratingController` drives every LLM call, routes tool calls through MCP, and manages conversation state. This works well for structured investigation chains but has inherent limitations:

- **Tool surface is MCP-only.** Agents can only use tools exposed by MCP servers. There is no way for an agent to read/write files, run shell commands, search codebases, or perform other developer-workflow actions unless a custom MCP server wraps each capability.
- **The agent loop is rigid.** TARSy controls iteration count, tool routing, and conversation flow. The LLM has no autonomy to decide its own workflow — it must respond within TARSy's turn structure.
- **Complex agentic tasks don't fit.** Some tasks (deep code analysis, multi-file investigation, running test suites, writing remediation scripts) benefit from a fully autonomous agent that can plan, execute, revise, and iterate without external turn management.

Claude Code is Anthropic's agentic coding tool. It runs its own agent loop with built-in tools (file read/write, Bash execution, code search, Git), supports MCP server integration, and can operate non-interactively via the Agent SDK. It can be containerized for isolation.

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

### Sidecar service

The sidecar wraps the official `@anthropic-ai/claude-agent-sdk` TypeScript SDK, exposing an HTTP endpoint. TARSy sends an HTTP POST with the prompt and configuration, and reads back an NDJSON stream of events. HTTP + NDJSON is aligned with Anthropic's hosting guidance for container-based SDK deployments.

**Isolation is fundamental**: Claude Code runs in a separate process/container with no access to TARSy's internals. This is the primary reason for the sidecar architecture — not just convenience.

### Deployment model

| Environment | Sidecar | CC Isolation | CC Features |
|---|---|---|---|
| **Dev (`make dev`)** | Standalone TypeScript service | Process separation | `settingSources: ["project"]` — skills, CLAUDE.md, rules from local workspace |
| **Containerized dev** | Sidecar container | Container isolation | `settingSources: ["project"]` — skills, CLAUDE.md, rules baked into image |
| **Production (Phase 1)** | Ephemeral pod-per-session | Full pod isolation (filesystem, network, resources) | `settingSources: ["project"]` — skills, CLAUDE.md, rules baked into pod image |

**Production model: pod-per-session.** Each CC agent execution gets a dedicated ephemeral pod in OpenShift. Pod is created on demand, destroyed after completion. This provides the safest isolation with no cross-session data leakage. At TARSy's expected load (~10 sessions/day), resource overhead is negligible. Skills, CLAUDE.md, and rules are baked into the pod image for reproducibility.

### What stays the same

- `BaseAgent` wraps the controller (execution status tracking, DB lifecycle)
- `AgentFactory` creates it from `ExecutionContext`
- Session executor creates `AgentExecution` DB records, wires up event publishing
- Timeline events stream to the dashboard via WebSocket
- The agent is configurable via `tarsy.yaml` like any other agent
- It can participate in chains (stages, synthesis after parallel agents)
- It can be dispatched as an orchestrator sub-agent (architecturally supported, tested post-PoC)

### What changes

- No `LLMClient` usage — Claude Code calls the Anthropic API directly
- No `ToolExecutor` usage — Claude Code has its own tools (Bash, Read, Edit, Grep, Glob) and can connect to MCP servers independently
- The Python LLM Service is bypassed entirely for this agent type
- A new streaming bridge maps Claude Code's NDJSON output to TARSy timeline events

## Key Concepts

### Execution model

The `ClaudeCodeController.Run()` method:

1. Builds the prompt from alert data, previous stage context, and custom instructions
2. Sends an HTTP POST to the sidecar with prompt, configuration, and allowed tools
3. Reads the NDJSON streaming response
4. Maps events to TARSy timeline events and publishes them via WebSocket
5. On stream completion, extracts the final result and token usage
6. Returns `ExecutionResult` with status, final analysis, and token usage

### Timeline events

A new `claude_code` timeline event type acts as a passthrough for Claude Code's native events. The sidecar streams whatever CC returns, and TARSy persists each event with its native structure. The frontend gets one new React component — a general-purpose Claude Code event renderer.

This avoids information loss from force-mapping to existing event types and keeps the schema simple (one new type, not one per CC event kind). The renderer can be refined over time as CC-specific rendering needs emerge.

### Tool access

**PoC:** Claude Code's built-in tools only — Bash, Read, Grep, Glob, etc. kubectl/helm access via environment variables (KUBECONFIG). No MCP bridging.

**Post-PoC:** May add MCP server integration (built-in tools + TARSy's MCP servers) when there's a concrete need for structured MCP tool access from within Claude Code. Decision deferred.

### Authentication

The sidecar gets credentials via environment variables at deployment time. Supports:
- **Direct Anthropic:** `ANTHROPIC_API_KEY`
- **Vertex AI:** `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials
- **Bedrock:** `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials

All CC agents in a deployment use the same auth backend. Per-request provider selection can be added post-PoC if needed.

### Cost and budget control

Claude Code can autonomously make many LLM calls. Cost control mechanisms:
- `maxTurns` option limits the number of agent loop cycles
- Context timeout from TARSy's session/execution timeout (kills the HTTP request)
- The final result includes `total_cost_usd` and token usage for tracking and DB storage

### CC features via `settingSources`

The sidecar uses the SDK's `settingSources: ["project"]` to load Claude Code features from the workspace's `.claude/` directory. This replaces the CLI's `--bare` flag with a more granular, SDK-native mechanism.

**Loaded from workspace (all phases including PoC):**
- `.claude/skills/*/SKILL.md` — SRE investigation skills, kubectl patterns, runbook skills
- `CLAUDE.md` — project instructions, environment details, conventions
- `.claude/rules/*.md` — always-on behavioral rules
- `.claude/settings.json` — filesystem hooks, tool configuration

**Not loaded (by design):**
- Auto-memory — CLI-only feature, SDK never loads it regardless of `settingSources`
- User-level settings (`~/.claude/`) — not meaningful in containers

**Workspace provisioning:**
- **Dev:** Workspace directory checked into repo (e.g., `deploy/claude-code/workspace/.claude/`)
- **Containerized/prod:** Baked into container image or mounted via ConfigMap

TARSy's own memory system (PostgreSQL-backed, semantic search, Tier 4 prompt injection) provides cross-session learning. CC auto-memory is irrelevant for the SDK approach.

### Configuration

```yaml
agents:
  ClaudeCodeInvestigator:
    type: claude_code
    description: >
      Investigates incidents using Claude Code with full shell access
      and file system tools.
    custom_instructions: |
      You are an SRE investigating a Kubernetes incident.
      Use kubectl, log files, and available CLI tools to investigate.
    claude_code:
      max_turns: 30
      allowed_tools: ["Bash", "Read", "Grep", "Glob", "Skill"]
      setting_sources: ["project"]
      workspace_dir: "deploy/claude-code/workspace"
```

## Implementation Phases

### Phase 0: PoC

- New `AgentTypeClaudeCode` + `ClaudeCodeController`
- TypeScript sidecar wrapping `@anthropic-ai/claude-agent-sdk` with HTTP + NDJSON endpoint
- Single sidecar instance (standalone service via `make dev`)
- `settingSources: ["project"]` — skills, CLAUDE.md, rules loaded from workspace
- Workspace directory with `.claude/skills/`, `CLAUDE.md`, rules checked into repo
- Built-in tools only (Bash, Read, Grep, Glob, Skill) — no MCP
- New `claude_code` timeline event type with passthrough rendering
- Static credentials via environment variables
- Basic dashboard component for CC events

### Phase 1: Production-ready

- Pod-per-session deployment in OpenShift
- Container image with CC SDK sidecar + workspace (skills, CLAUDE.md, rules baked in)
- Kubernetes API integration for pod lifecycle management
- Cost tracking and token usage in DB
- Timeout and cancellation via HTTP request termination + pod cleanup

### Future considerations (deferred)

- MCP server integration (built-in tools + TARSy's MCP servers)
- Orchestrator sub-agent validation
- Per-request provider selection (mixed Anthropic/Vertex deployments)
- CC auto-memory (CLI-only feature — would require different integration approach if ever needed)
- `settingSources: ["user"]` for user-level skills (not meaningful in containers currently)
- Dedicated dashboard components for CC-specific event rendering

## Use Cases

### Primary: Deep investigation with shell/file access

Alerts that require running commands, reading logs, analyzing config files, or performing multi-step diagnosis that the current MCP-only tool surface can't handle well.

### Secondary: Orchestrator sub-agent

The orchestrator dispatches a Claude Code agent for tasks that benefit from autonomous exploration — "investigate why pods are OOMKilling by checking memory limits, recent deployments, and node resource usage."

### Future: Remediation with code generation

Action stages where Claude Code writes and applies remediation scripts, Kubernetes manifests, or configuration changes — with pod isolation for safety.

## What Is Out of Scope

- **Replacing existing agents** — Claude Code is an additional agent type, not a replacement for existing investigation/synthesis/scoring agents
- **Interactive Claude Code sessions** — only headless/programmatic execution via the Agent SDK
- **Claude Code on the web** (Anthropic's hosted version) — TARSy runs its own Claude Code instances
- **Multi-model routing within Claude Code** — Claude Code uses Anthropic models only; TARSy's multi-provider system handles other models via existing agent types
- **Custom tool development for Claude Code** — using Claude Code's built-in tools and standard MCP, not building custom SDK tools
- **CC auto-memory persistence** — CLI-only feature not available in SDK; TARSy's own memory system provides cross-session learning
