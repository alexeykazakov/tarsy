# GitHub App Authentication

**Status:** Draft — pending decisions from [github-app-auth-questions.md](github-app-auth-questions.md)

## Overview

TARSy talks to GitHub in two places:

1. **Runbooks** — `pkg/runbook` downloads runbook files (`raw.githubusercontent.com`) and lists a runbook directory (Contents API). It authenticates with one static token read from `system.github.token_env` (default `GITHUB_TOKEN`) in `cmd/tarsy/main.go`.
2. **GitHub MCP servers** — e.g. a post-investigation agent that files issues through the official `github-mcp-server` in `http` mode. The server holds no credentials; TARSy sends one as `transport.bearer_token`, usually `"{{.SOME_PAT}}"`. That value is expanded once at config load (`pkg/config/loader.go`) and stored in `bearerTokenTransport` (`pkg/mcp/transport.go`).

Both only work with long-lived tokens, in practice personal access tokens (PATs). PATs belong to a user or a machine account, must be rotated by hand, expire per org policy, and often need org approval.

This proposal adds **GitHub App** authentication as an alternative. TARSy holds the App's private key and mints short-lived installation access tokens on demand. PATs keep working unchanged and stay the simplest option for local and small deployments.

## Design Principles

- **PATs stay first-class.** Existing configs keep working with no changes. The App is opt-in.
- **Tokens are fetched per request, not at config load.** Installation tokens expire after 1 hour. Every consumer asks a token source when it sends a request, and the source caches and refreshes.
- **Least privilege per consumer.** One App can cover several consumers. Each consumer gets a token narrowed to what it needs (repositories, permissions), not the installation's full grant.
- **Generic.** Nothing specific to a deployment, repository or MCP server. The MCP side is "this server authenticates with a GitHub App token", not "this is the issue-filing server".
- **Fit the planned MCP auth model.** The [token-exchange sketch](token-exchange-sketch.md) plans an `auth` block on MCP servers and a context-aware RoundTripper that replaces `bearerTokenTransport`. This design should be the first user of that model, not a competitor to it.

## Architecture

```
                         system.github.app
                    (client ID + private key)
                               │
                               ▼
                    ┌──────────────────────┐   GET  /app/installations          (JWT)
                    │   pkg/githubapp.App  │── POST /app/installations/{id}/access_tokens
                    │  - signs JWT (RS256) │        {repositories, permissions}
                    │  - owner → install ID│
                    │  - token cache       │◄── cached until ~5 min before expires_at
                    └──────────┬───────────┘
              Token(ctx)       │        TokenForOwner(ctx, owner)
           ┌───────────────────┴─────────────────────┐
           ▼                                         ▼
┌────────────────────────────┐          ┌───────────────────────────────┐
│ MCP githubAppTransport     │          │ runbook.GitHubClient          │
│ (auth.mode: github_app)    │          │ owner parsed from runbook URL │
│ per HTTP request:          │          │ per request:                  │
│ Authorization: Bearer ghs_…│          │ Authorization: Bearer ghs_…   │
└──────────────┬─────────────┘          └───────────────┬───────────────┘
               ▼                                        ▼
       github-mcp-server (http)              api.github.com / raw.githubusercontent.com
```

With a PAT, the same consumer interfaces are backed by a static source, so runbook and MCP code don't care which kind of credential is configured.

### Configuration

```yaml
system:
  github:
    # Option 1 (existing): PAT
    token_env: "GITHUB_TOKEN"

    # Option 2 (new): GitHub App. Mutually exclusive with an explicit token_env.
    app:
      client_id: "Iv23liEXAMPLE"                              # JWT issuer: client ID (preferred by GitHub) or numeric App ID
      private_key_path: "/etc/tarsy/github-app/private-key.pem"

mcp_servers:
  github:
    transport:
      type: "http"
      url: "https://github-mcp-server:8443/"
    auth:
      mode: "github_app"
      github_app:
        owner: "example-org"           # account the App is installed on
        repositories: ["tickets"]      # optional narrowing
        permissions:                   # optional narrowing
          issues: "write"
          contents: "read"
```

> **Open question:** where MCP GitHub App auth is configured (`auth` block vs a transport field) — see [questions document](github-app-auth-questions.md), Q1.

> **Open question:** private key as a file path, env var, or both — see [questions document](github-app-auth-questions.md), Q4.

### Runbooks flow

1. `runbook.Service` gets a `TokenProvider` instead of a token string.
2. For each request, `GitHubClient` parses the owner from the runbook URL (already done by `ParseRepoURL` / `ConvertToRawURL`) and calls `TokenForOwner(ctx, owner)`.
   - PAT provider: always returns the PAT (or `""` when unset, as today).
   - App provider: looks up the installation for `owner`. If there is one, returns a token narrowed to `contents: read`. If the App is not installed for that owner, returns `""` and the request goes out anonymously, which works for public repos (the same as running without a token today).
3. Fetch failures keep the existing fail-open policy: the caller falls back to the default runbook.

Runbook tokens are not narrowed to specific repositories, because per-alert runbook URLs can point to any repository the installation covers. Only permissions are narrowed (`contents: read`), since that is all runbooks ever need.

### MCP flow

1. When an MCP server has `auth.mode: github_app`, `buildHTTPClient` installs `githubAppTransport` instead of `bearerTokenTransport`.
2. On every HTTP request, the transport calls `source.Token(req.Context())` and sets `Authorization: Bearer <token>`. As `bearerTokenTransport` does now, it only attaches the header for the configured endpoint host, so a redirect to another host doesn't get the credential.
3. The source is built once per MCP server at startup and shared by every `Client` the factory creates (sessions, health monitor, chat), so they all share one cached token per server.

This fixes token expiry wherever it would hit: long health-monitor clients, sessions recreated after errors, and long-lived streamable-HTTP connections. The one exception is a single SSE GET stream that stays open for more than an hour without reconnecting. It keeps the token it opened with, and GitHub doesn't use that token after the handshake, since every tool call is a new POST with a fresh header.

> **Open question:** how the installation is chosen (owner lookup vs explicit installation ID) — see [questions document](github-app-auth-questions.md), Q2.

> **Open question:** whether MCP `github_app` auth must declare `repositories` / `permissions` — see [questions document](github-app-auth-questions.md), Q3.

### Errors and startup

- **Startup:** read and parse the private key. Fail startup on a missing or invalid key, or on an invalid `auth` block (config error, same as other validation). Don't call GitHub at startup, so a GitHub outage can't stop TARSy from starting.
- **Runtime:** minting or lookup failures are returned as errors with the cause, e.g. `GitHub App is not installed for account "example-org"` or `mint installation token: HTTP 401 (check client_id, key, clock)`.
  - MCP: the error surfaces as a failed request. The MCP health monitor already reports this per server, and agents already handle failed servers.
  - Runbooks: an error leads to the existing fallback and warning path.
- **Token values are never logged.** They are already masked: the built-in `github_token` pattern covers `ghs_…`.

### Config viewer

- `GitHubView` (`pkg/api/system_config.go`) gains `auth` (`token` | `app`) and `app_client_id`. Nothing secret is shown: no key path contents, no tokens.
- The MCP server view gains `auth_mode` next to `bearer_token_set`.
- Update the dashboard types in `web/dashboard/src/types/system.ts` and `ConfigViewer.tsx` to match.

## Core Concepts

### One App per TARSy instance

`system.github.app` configures a single App. One App installed on every account and repository TARSy needs, plus per-consumer narrowed tokens, gives least privilege per consumer. A second App wouldn't add real isolation, because both private keys would sit in the same pod and Secret. Splitting only pays off when separate teams own separate Apps, or when an App's installation is restricted to its owning account and TARSy needs more accounts. If that comes up, `app` can become a named map later without changing how consumers request tokens.

### `TokenSource` and `TokenProvider`

```go
// pkg/githubapp
type TokenSource interface {
    Token(ctx context.Context) (string, error)    // fixed scope (MCP server)
}

type TokenProvider interface {
    TokenForOwner(ctx context.Context, owner string) (string, error) // "" = no credential for owner (runbooks)
}
```

- `StaticToken` implements both and backs PAT setups.
- `App.Source(owner, repositories, permissions)` returns a `TokenSource` for one MCP server.
- `App.Provider(permissions)` returns a `TokenProvider` for runbooks.

### Installation lookup

`GET /app/installations` (JWT, paginated) returns every installation with its `account.login`. The App caches `login → installation ID`. On a miss it re-lists, at most once a minute, so a newly installed account is picked up without a restart and an unknown owner can't trigger a stream of API calls. Owner matching is case-insensitive, like GitHub logins.

### Token cache

- Keyed by (installation ID, sorted repositories, sorted permissions).
- A cached token is reused until 5 minutes before its `expires_at`.
- Concurrent callers wait for a single mint (mutex per key).
- No reactive retry on 401. The proactive margin covers expiry. If GitHub revokes a token early (rare), the next request after the cache entry expires recovers.
- The JWT is signed per mint with `iat = now - 60s` (clock skew) and `exp = now + 9m` (GitHub's maximum is 10 minutes).

### Choosing between PAT and App

| `system.github` | Runbooks use | MCP `bearer_token` | MCP `auth.mode: github_app` |
|---|---|---|---|
| nothing / `token_env` | PAT from env (or anonymous) | works | config error |
| `app` | App (anonymous for owners without an installation) | works | works |
| `app` + explicit `token_env` | config error | — | — |

`token_env` defaults to `GITHUB_TOKEN`, so "both configured" means `token_env` was written out explicitly. That is rejected rather than guessed. A static `bearer_token` on any MCP server works in every setup, so PAT-based MCP servers can live alongside an App.

### Out of scope

- **stdio MCP servers.** The official `github-mcp-server` does App authentication by itself in stdio mode (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`) and refreshes its own tokens. The docs will point there. Injecting App tokens into stdio env vars would only be fresh at spawn time.
- **GitHub Enterprise Server / `ghe.com`.** The runbook client hard-codes `api.github.com` today. A `system.github.api_url` would be a small follow-up for both.
- User-to-server tokens, webhooks, multiple Apps.

## Implementation Plan

### Step 0 — Verify with a real App (no PR)

Create a test App with Contents read and Issues read/write, install it on a throwaway private repo, mint an installation token by hand, and check:

- `raw.githubusercontent.com` returns a private file with `Authorization: Bearer ghs_…`. If not, the runbook client downloads through the Contents API (`Accept: application/vnd.github.raw`) when an App is configured.
- The Contents API directory listing works.
- `github-mcp-server http` accepts the token (its header parser recognises `ghs_`) and the issue/contents tools work, including setting labels on issue create.
- Note which tools fail with installation tokens (e.g. `get_me` uses `/user`) for the docs.

### PR 1 — `pkg/githubapp` + runbooks on GitHub App

**Lands**
- `pkg/githubapp`: `App` (JWT signing, installation lookup and cache, scoped token minting and cache), `StaticToken`, the `TokenSource` / `TokenProvider` interfaces. Base URL injectable for tests. JWT via `github.com/golang-jwt/jwt/v5` (see Q5).
- Config: `GitHubYAMLConfig.App` → resolved `GitHubConfig.App`. Validation: `app` requires `client_id` and the key; `app` plus an explicit `token_env` is an error. Load and parse the key during config init.
- `runbook.NewService` takes a `TokenProvider`. `GitHubClient` gets the token per request by owner. `main.go` builds a PAT or App provider. The "GitHub token not configured" warning only applies to the PAT path.
- Config viewer: `GitHubView` `auth` / `app_client_id`, dashboard types and viewer.
- Docs: `deploy/config/tarsy.yaml.example` (`system.github.app`), and the related config reference in `docs/`.

**Tests in this PR**
- `pkg/githubapp`, against an `httptest` GitHub and a generated RSA key: JWT claims verified with the public key; requested `repositories` / `permissions` body; installation lookup, case-insensitive match, re-list on miss with the once-a-minute limit; cache reuse, refresh inside the 5-minute margin (injectable clock); one mint for concurrent callers; error messages for 401/404.
- `pkg/runbook`: fake provider. Token chosen by URL owner, anonymous when the provider returns `""`, existing PAT behaviour unchanged.
- `pkg/config`: loader and validator cases for `app`, the mutual-exclusion error, a bad key path or PEM.
- `pkg/api`: system config view.

**Gap:** none. Existing PAT configs behave exactly as before.

### PR 2 — MCP `auth` block with `mode: github_app`

**Lands**
- `MCPServerConfig.Auth` (`AuthConfig{Mode, GitHubApp}`), with the `auth` sibling block shaped as the token-exchange sketch plans. Only `github_app` is implemented. No `auth` block means today's behaviour (`bearer_token`, the sketch's implicit `shared` mode).
- Validation: `github_app` requires `system.github.app`, an `http`/`sse` transport, `owner`, and no `bearer_token`. Permission names and levels are only checked for shape (`read` | `write` | `admin`) and are otherwise left to GitHub.
- `pkg/mcp`: one `TokenSource` per `github_app` server, built when the `ClientFactory` is created. `githubAppTransport` in `buildHTTPClient` (host-restricted like `bearerTokenTransport`). `needsCustomHTTPClient` accounts for `auth`.
- Config viewer: `auth_mode` on MCP servers, dashboard.
- Docs: `tarsy.yaml.example` MCP example, and a note in `deploy/config/post-investigation-local-test.md` that stdio `github-mcp-server` can use its own App flags instead of a PAT.

**Tests in this PR**
- `pkg/mcp` transport: an `httptest` MCP endpoint records `Authorization`. The fake source rotates its token, and the next request carries the new one. Not sent across hosts on redirect. Source errors make the request fail with the cause.
- `pkg/config`: validator cases above.
- `pkg/api`: view.
- **No new e2e test:** the e2e harness would need a fake GitHub token endpoint and an MCP server that checks it. The transport test covers the same path at lower cost, and Step 0 plus a deploy check cover the real GitHub path.

**Gap:** none. Servers without `auth` are untouched.

### After merge

- Roll out in a deployment. Verify the MCP server's health and one runbook fetch from a private repo.
- Promote this proposal to an ADR (`/promote-to-adr`).

## Open Questions

| # | Question | Section |
|---|---|---|
| Q1 | Where MCP GitHub App auth is configured | [Configuration](#configuration) |
| Q2 | How the installation is chosen | [MCP flow](#mcp-flow), [Installation lookup](#installation-lookup) |
| Q3 | Whether MCP `github_app` auth must declare repositories and permissions | [MCP flow](#mcp-flow) |
| Q4 | Private key input: file path, env var, or both | [Configuration](#configuration) |
| Q5 | Use `ghinstallation` or a small in-repo client | [PR 1](#pr-1--pkggithubapp--runbooks-on-github-app) |

Full options and recommendations: [github-app-auth-questions.md](github-app-auth-questions.md).
