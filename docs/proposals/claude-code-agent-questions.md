# Claude Code Agent — Sketch Questions

**Status:** Open — decisions pending  
**Related:** [Sketch document](claude-code-agent-sketch.md)

Each question has options with trade-offs and a recommendation. Go through them one by one to form the sketch, then update the sketch document.

---

## Q1: How does TARSy invoke Claude Code?

The Claude Code Agent SDK offers three integration surfaces: CLI with `-p` flag, TypeScript SDK (`@anthropic-ai/claude-agent-sdk`), and Python SDK. Each has different complexity, streaming fidelity, and deployment implications for a Go-based orchestrator.

### Option B: TypeScript SDK sidecar (chosen)

Run a TypeScript service wrapping the `@anthropic-ai/claude-agent-sdk` `query()` function. TARSy communicates with it over **HTTP + NDJSON streaming** — aligned with Anthropic's hosting guidance ("expose HTTP/WebSocket endpoints for external clients while the SDK runs internally within the container").

- **Pro:** Richest integration — tool approval callbacks, structured message objects, native streaming, hooks, subagents, session resumption
- **Pro:** Can define custom tools via `createSdkMcpServer` for TARSy-specific operations
- **Pro:** Isolation by design — Claude Code runs in a separate process/container with no access to TARSy's internals
- **Pro:** HTTP + NDJSON is trivial to implement in Express/Fastify and consume in Go (buffered reader on chunked response)
- **Con:** Adds a new service to deploy and maintain

**Deployment model:**
- **Dev (`make dev`):** Standalone TypeScript service running locally
- **Containerized (dev & prod):** Sidecar container — isolated from TARSy's container

**Protocol: HTTP + NDJSON streaming.** Anthropic's hosting docs recommend HTTP. Their entire ecosystem is HTTP-native (API uses SSE, SDK outputs NDJSON). gRPC is not mentioned anywhere in Anthropic's Agent SDK documentation and would add unnecessary protobuf compilation for TypeScript.

**Notable discovery:** A community Go SDK (`github.com/roasbeef/claude-agent-sdk-go`, v1.0.8, MIT) wraps the Claude CLI as a local subprocess with full streaming, MCP tools, and hooks — all from pure Go. However, it spawns local subprocesses and doesn't provide cross-container isolation. Not suitable for the isolation requirement, but validates the CLI protocol design.

**Decision:** Option B — isolation is a fundamental requirement; Claude Code must not have access to TARSy's container. HTTP + NDJSON is the protocol, aligned with Anthropic's guidance.

_Considered and rejected: Option A — CLI subprocess (no isolation, Claude Code runs in TARSy's process space), Option C — Python SDK in existing LLM service (contradicts stateless design, mixes execution models)._

---

## Q2: How is Claude Code isolated?

_Resolved by Q1._ The sidecar architecture inherently provides isolation — Claude Code runs in a separate process (dev) or separate container (containerized environments) with no access to TARSy's internals.

- **Dev (`make dev`):** Process-level isolation — the TypeScript sidecar runs as a standalone service in its own process
- **Containerized (dev & prod):** Container-level isolation — sidecar container with its own filesystem, network namespace, and resource limits. Claude Code cannot access TARSy's container.

**Decision:** Isolation follows directly from Q1's sidecar decision. Container isolation (filesystem, network, resource limits) in containerized environments; process separation in local dev.

_Considered and rejected: Option A — direct subprocess in TARSy's process (no isolation), Option C — Docker Sandbox (requires Docker Desktop, not viable for servers)._

---

## Q3: What tools does Claude Code get access to?

Claude Code has built-in tools (Bash, Read, Write, Edit, Grep, Glob) and supports MCP servers. The question is what combination makes sense for TARSy's SRE investigation use case, and how it interacts with TARSy's existing MCP infrastructure.

### Option A: Claude Code built-in tools only (chosen for PoC)

Give Claude Code access to its own tools (Bash, Read, Grep, etc.) and configure kubectl/helm access via environment variables (KUBECONFIG). No MCP servers.

- **Pro:** Simplest configuration — no MCP bridging needed
- **Pro:** `kubectl` via Bash is arguably more flexible than the kubernetes MCP server (full CLI surface vs limited tool set)
- **Pro:** No dependency on TARSy's MCP infrastructure
- **Con:** Loses structured tool output that MCP provides (e.g., data masking, summarization)
- **Con:** Raw kubectl output can be very large — Claude Code handles this with its own context management, but TARSy can't apply its summarization pipeline

### Option C: Both — built-in tools + MCP servers

Give Claude Code its built-in tools and also connect it to TARSy's MCP servers.

- **Pro:** Maximum flexibility — Claude Code can choose the best tool for each task
- **Pro:** Bash for ad-hoc commands, MCP for structured data access
- **Con:** Overlapping tool surfaces might confuse the LLM (e.g., should it use `kubectl` via Bash or via kubernetes MCP server?)
- **Con:** Custom instructions needed to guide tool selection

**Decision:** Option A for Phase 0 (PoC) — built-in tools only with `kubectl` via Bash. Simplest path, most natural Claude Code usage. Post-PoC phases may adopt Option C (built-in + MCP) but that decision is deferred until production-readiness planning.

_Considered and rejected for PoC: Option B — MCP servers only (loses Claude Code's natural tool surface, adds bridging complexity for no PoC benefit)._

---

## Q4: How does Claude Code output map to TARSy's dashboard?

TARSy's dashboard renders timeline events: thinking blocks, streaming text, tool calls with expandable results, final analysis. Claude Code's NDJSON stream has its own event format. The question is how to bridge the two.

### New `ClaudeCode` event type — passthrough approach (chosen)

Create a single new timeline event type (`claude_code`) that acts as a container for Claude Code's native events. The sidecar streams whatever Claude Code returns, and TARSy persists each event with its native structure in the timeline. The frontend gets one new React component that knows how to render the Claude Code event stream generically.

- **Pro:** No lossy translation — Claude Code events are preserved as-is
- **Pro:** Single new event type, not one per CC event kind — keeps the schema simple
- **Pro:** Frontend rendering evolves independently — start with a general renderer, refine later
- **Pro:** Future-proof — if Claude Code adds new event types, they flow through without backend changes
- **Con:** Requires one new frontend component (but it's a single, general-purpose renderer)
- **Con:** Claude Code events look different from existing TARSy timeline events (intentional — they _are_ different)

**Decision:** New `claude_code` timeline event type with passthrough of native CC events. The frontend builds a general-purpose Claude Code renderer. This avoids both the information loss of force-mapping to existing types and the complexity of per-event-kind type explosion.

_Considered and rejected: Option A — map to existing types (lossy, Bash-as-MCP-tool looks wrong), Option B — multiple new event types per CC event kind (unnecessary complexity), Option C — existing types with metadata (hides CC detail behind invisible metadata)._

---

## Q5: How are Claude Code credentials managed?

Claude Code supports multiple auth backends: direct Anthropic (`ANTHROPIC_API_KEY`), Vertex AI (`CLAUDE_CODE_USE_VERTEX=1` + GCP credentials), and Bedrock (`CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials). TARSy already uses Vertex AI for Claude models (`vertexai-claude-sonnet` in config). The question is how the sidecar gets its credentials.

### Option A: Static sidecar credentials (chosen)

The sidecar container gets credentials via environment variables at deployment time. All Claude Code agents in a deployment use the same auth backend.

- **Pro:** Simplest — standard container env var configuration
- **Pro:** Matches how the Python LLM service gets its own provider keys
- **Pro:** Supports all backends: `ANTHROPIC_API_KEY` for direct, `CLAUDE_CODE_USE_VERTEX=1` + GCP creds for Vertex, `CLAUDE_CODE_USE_BEDROCK=1` + AWS creds for Bedrock
- **Con:** Can't mix direct-Anthropic and Vertex agents in the same deployment

**Decision:** Option A — static credentials on the sidecar via environment variables. The sidecar is configured with one auth backend per deployment (direct Anthropic or Vertex AI). Per-request provider selection (Option B) can be added post-PoC if mixed-provider deployments are needed.

_Considered and rejected for PoC: Option B — per-request provider selection (adds protocol complexity, no PoC need), Option C — config block in tarsy.yaml (unnecessary indirection when env vars suffice)._

---

## Q6: Can the Claude Code agent be used as an orchestrator sub-agent?

The existing orchestrator dispatches sub-agents via `SubAgentRunner.Dispatch()`, which creates an `AgentExecution` record, resolves config, and runs the agent in a goroutine. The question is whether a Claude Code agent can participate in this system.

### Option A: Yes — works via existing `AgentFactory` (chosen)

The orchestrator dispatches a Claude Code agent the same way it dispatches any other sub-agent. `AgentFactory.CreateAgent()` creates a `BaseAgent` wrapping a `ClaudeCodeController`. The controller calls the sidecar over HTTP. Results flow back through the same `SubAgentResult` channel.

- **Pro:** Zero changes to the orchestrator — it already works with any `Agent` implementation
- **Pro:** The Claude Code sub-agent gets full lifecycle management (timeout, cancellation, status tracking)
- **Pro:** Results flow back through the same `SubAgentResult` channel

**Decision:** Option A — architecturally supported by design (same `Agent` interface). PoC scope is standalone stage execution only; orchestrator sub-agent integration is validated post-PoC.

_Considered and rejected: Option B — restrict to standalone stage only (artificial limitation with no technical basis)._

---

## Q7: What workspace does Claude Code operate in?

Claude Code operates within a working directory — it can read files, run commands, and navigate the filesystem relative to this directory. For TARSy's SRE use case, the question is what that workspace contains.

### Option A: Empty workspace with environment access

Claude Code starts in an empty/minimal workspace. All investigation happens through CLI tools (kubectl, curl, etc.) and environment variables (KUBECONFIG, cloud credentials).

- **Pro:** Minimal setup — no workspace provisioning needed
- **Pro:** Mirrors how SRE engineers work — they SSH into a machine and use CLI tools
- **Con:** Claude Code can't read runbooks, config files, or previous investigation artifacts unless they're piped in via the prompt

### Option B: Provisioned workspace with mounted content

Create a temporary workspace directory with relevant files: runbook content, alert data, previous stage analysis, relevant configuration files. Mount it (or create it) before spawning Claude Code.

- **Pro:** Claude Code can reference files during investigation (runbooks, configs, previous analysis)
- **Pro:** In container mode, the mount defines the filesystem boundary
- **Con:** Requires workspace provisioning logic (create temp dir, write files, clean up)
- **Con:** Deciding what to include in the workspace adds complexity

### Option C: Shared persistent workspace per session

All agents in a session share a workspace directory. Files created by one agent are accessible to the next stage.

- **Pro:** Enables multi-stage workflows where Claude Code builds on previous work
- **Pro:** Natural for investigation → remediation pipelines (investigation writes notes, action reads them)
- **Con:** State management across stages adds complexity
- **Con:** Cleanup must be handled carefully
- **Con:** Only relevant if multiple Claude Code agents run in the same session

**Recommendation:** Option B. A provisioned temporary workspace with alert data and runbook content gives Claude Code useful context without complexity. The workspace is created before the controller spawns Claude Code and cleaned up after. In container mode, this directory becomes the mount point — a natural boundary.
