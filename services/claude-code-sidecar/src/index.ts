import { execSync } from "child_process";
import path from "path";
import express from "express";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryRequest } from "./types.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = parseInt(process.env.PORT || "3100", 10);

function resolveClaudePath(): string {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "claude CLI not found on PATH. Install it (npm i -g @anthropic-ai/claude-code) or set CLAUDE_CODE_PATH.",
    );
  }
}

const claudePath = resolveClaudePath();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/query", async (req, res) => {
  const body = req.body as QueryRequest;

  if (!body.prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abortController.abort();
  });

  try {
    const cwd = body.workspace_dir
      ? path.resolve(body.workspace_dir)
      : process.cwd();

    const settingSources = (body.setting_sources ?? ["project"]) as Array<
      "user" | "project" | "local"
    >;

    const systemPrompt = body.system_prompt
      ? {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: body.system_prompt,
        }
      : { type: "preset" as const, preset: "claude_code" as const };

    const result = query({
      prompt: body.prompt,
      options: {
        pathToClaudeCodeExecutable: claudePath,
        abortController,
        cwd,
        maxTurns: body.max_turns,
        allowedTools: body.allowed_tools ?? [
          "Bash",
          "Read",
          "Grep",
          "Glob",
          "Skill",
        ],
        settingSources,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: {
          ...process.env,
          ...body.env,
        } as Record<string, string>,
      },
    });

    for await (const message of result) {
      if (abortController.signal.aborted) break;
      writeLine(res, message);
    }
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Unknown sidecar error";
    console.error("Query error:", errorMsg);

    if (!res.headersSent) {
      res.status(500).json({ error: errorMsg });
      return;
    }

    writeLine(res, {
      type: "result",
      subtype: "error_during_execution",
      uuid: crypto.randomUUID(),
      session_id: "",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [errorMsg],
    });
  } finally {
    res.end();
  }
});

function writeLine(res: express.Response, data: SDKMessage | object): void {
  try {
    res.write(JSON.stringify(data) + "\n");
  } catch {
    // Client disconnected
  }
}

app.listen(PORT, () => {
  console.log(`CC sidecar listening on :${PORT} (claude: ${claudePath})`);
});
