# GitHub App Authentication — Design Questions

**Status:** Open — decisions pending
**Related:** [Design document](github-app-auth-design.md)

Each question has options with trade-offs and a recommendation. Go through them one by one to form the design, then update the design document.

---

## Q1: How does an MCP server get a GitHub App token?

Today an MCP server's credential is `transport.bearer_token`, a string expanded once at load. An App token has to be fetched per request from something that mints and refreshes it. The same limit blocks other short-lived credentials too, e.g. projected Kubernetes service-account tokens that kubelet rotates in a file (see Q6). Whatever the YAML looks like, the code underneath is the same: one `TokenSource` interface behind a single bearer RoundTripper, with `bearer_token` becoming a static source.

### Option B: Separate `auth` block next to `transport`
```yaml
auth:                       # exactly one key, like Kubernetes volume sources
  github_app: { owner: "example-org", repositories: [...], permissions: {...} }
  # or: bearer_token: "{{.TOKEN}}"
  # or: bearer_token_file: "/var/run/secrets/tokens/mcp"   (if Q6 adds it)
```
- **Pro:** One place for all auth. The block can later also say how the credential is attached (e.g. an `X-API-Key` header instead of `Authorization: Bearer`) and hold richer modes (per-user tokens) without filling `transport` with auth settings.
- **Con:** Config plumbing for a new section (struct, validation, viewer). `transport.bearer_token` has to keep working next to it.

Refinements agreed:
- **No `type` field.** Exactly one key is set, and the key is the type. A separate `type: github_app` would say the same thing twice and add a mismatch error.
- **`transport.bearer_token` stays accepted permanently.** The loader turns it into `auth.bearer_token`. Setting both is a config error. Docs and examples use `auth`. No deprecation warning, so existing deployments don't have to change.

**Decision:** Option B with the refinements above. Auth is its own concern, and a block leaves room for how the credential is attached and for richer modes, without overloading `transport`.

_Considered and rejected: Option A — flat `github_app` / `bearer_token_file` fields in `transport` (less plumbing, but auth would spread through `transport` as it grows), Option C — `bearer_token_file` plus an external minting sidecar (sidecar per deployment; runbooks still need App support)_

---

## Q2: How does TARSy choose the App installation?

An App has one installation per account (org or user) it is installed on, and tokens are minted per installation. Runbooks know the owner from each URL. An MCP server can't tell TARSy which repositories the agent will touch, so its config has to say.

### Option A: By account login (`owner`), looked up through `GET /app/installations` and cached
- **Pro:** Readable config (`owner: example-org`). Reinstalling the App changes the installation ID but needs no config change. The same lookup serves runbooks, where the owner comes from the URL. New installations are picked up on a cache miss without a restart.
- **Con:** One extra API call on cold start or on a miss, rate-limited to once a minute. Needs the miss behaviour defined: anonymous for runbooks, error for MCP.

### Option B: Explicit `installation_id` in config
- **Pro:** No lookup, and deterministic.
- **Con:** Opaque numbers that change on reinstall. Runbooks would still need a lookup (or a map of owner → ID) because per-alert URLs can name any owner.

### Option C: A, with an optional `installation_id` override
- **Pro:** Covers the odd case where a lookup isn't wanted.
- **Con:** Two ways to say the same thing, plus tests for both, with no concrete need.

**Recommendation:** Option A. Runbooks need owner lookup anyway, so MCP gets it for free, and configs survive App reinstalls.

---

## Q3: Must an MCP `github_app` server declare `repositories` and `permissions`?

A minted token can be narrowed to some repositories and lower permission levels than the installation has. Without narrowing, the token has everything the installation grants for that owner. With one App shared by several consumers (e.g. runbook reads on one repo, issue writes on another), that is the union of their needs.

### Option A: Optional; default is the full installation grant for `owner`
- **Pro:** Least config. Fine when the App is installed narrowly and has a single consumer.
- **Con:** With a shared App the MCP server silently gets more than it needs. That is easy to miss and is exactly the setup we recommend (one App per instance).

### Option B: `permissions` required, `repositories` optional
- **Pro:** Every MCP server states what it may do, which is visible in config and in the config viewer. A shared App can't leak write access to a server meant to read. Repository narrowing stays optional, because some servers legitimately work across an org.
- **Con:** A few more lines per server. Permission names must match GitHub's (`issues`, `contents`, `pull_requests`…), and a typo shows up as a GitHub 422 at the first request, not at startup.

### Option C: Both required
- **Pro:** Tightest scope.
- **Con:** Breaks valid org-wide uses (search across an org's repos) unless the operator lists every repository.

**Recommendation:** Option B. Requiring `permissions` makes least privilege the default with a shared App, at almost no cost. Repository scope stays the operator's choice.

---

## Q4: How is the private key supplied?

The key can mint tokens for every installation of the App, so it is more powerful than any one PAT. TARSy's convention for secrets is `*_env` (`token_env`, Slack `token_env`). Note that stdio MCP subprocesses inherit TARSy's whole environment (`createStdioTransport` starts from `os.Environ()`), so anything in env is visible to every stdio server process TARSy spawns.

### Option A: `private_key_env` (PEM in an env var)
- **Pro:** Same as other TARSy secrets. Works with `.env` for local dev.
- **Con:** The key ends up in every stdio MCP subprocess's environment and in `/proc/<pid>/environ`. Multi-line PEM in env is awkward (many setups need `\n` escaping).

### Option B: `private_key_path` (PEM file, e.g. a mounted Secret)
- **Pro:** Not inherited by subprocesses. The standard Kubernetes pattern for keys, and what `github-mcp-server` itself prefers. Works locally with a gitignored file.
- **Con:** Differs from the `*_env` convention. Local setup needs a file instead of a `.env` line.

### Option C: Both, mutually exclusive
- **Pro:** Operator's choice.
- **Con:** More config, more tests, and an easy path back to the weaker option.

**Recommendation:** Option B. The key is the most sensitive secret TARSy would hold, and keeping it out of the environment avoids handing it to subprocesses. The client ID isn't secret and goes in YAML as plain text.

---

## Q5: Use `ghinstallation` or write a small client?

`github.com/bradleyfalzon/ghinstallation/v2` is the common Go library for App auth. It gives an `http.RoundTripper` that signs JWTs and refreshes installation tokens, and supports narrowing options.

### Option A: `ghinstallation/v2`
- **Pro:** Widely used, handles JWT and refresh. Less code to own.
- **Con:** One Transport per installation ID fixed at construction, so TARSy still needs the owner lookup, a per-scope cache of Transports, and a way to get the raw token (`Token(ctx)`) for the MCP header. It adds `go-github` to the dependency tree. Its RoundTripper is aimed at `api.github.com`, while TARSy also needs the token for `raw.githubusercontent.com` and the MCP server.

### Option B: Small in-repo `pkg/githubapp` on `golang-jwt/jwt/v5`
- **Pro:** About 200 lines: sign the JWT, list installations, `POST …/access_tokens`, cache by scope. It matches the design exactly (owner lookup, scope keys, injectable clock and base URL), with a single small dependency. Easy to test against `httptest`.
- **Con:** We own the edge cases: pagination, clock skew, error mapping. They are well documented and few.

**Recommendation:** Option B. With owner lookup and per-consumer scopes, the library would only cover the JWT signing and token request, which `golang-jwt` plus a few lines also cover, while it adds a larger dependency and a Transport model that doesn't fit the MCP and runbook needs.

---

## Q6: Also add `bearer_token_file` (re-read on change) in this work?

Once Q1's `TokenSource` exists, a file-backed source costs very little: read the file, cache it, re-read when its modification time changes. It makes TARSy work with any credential that something else refreshes in a file, most usefully **projected Kubernetes service-account tokens**. Those are bound to an audience, expire, and kubelet rotates them automatically. They replace long-lived `kubernetes.io/service-account-token` Secrets, which Kubernetes discourages and which never expire unless someone rotates them. Today TARSy can't use projected tokens for MCP servers behind kube-rbac-proxy, because it reads `bearer_token` once.

### Option A: Yes, as a small separate PR after the GitHub App PRs
- **Pro:** A real security improvement for every kube-rbac-proxy-fronted MCP server, at roughly 50 lines plus tests, built on the same abstraction. It also proves the abstraction is general, not GitHub-shaped.
- **Con:** Slightly wider scope. Deployments only benefit after they switch their manifests (projected volume with an audience, and kube-rbac-proxy audience config), which is separate work.

### Option B: Not now; note it as a follow-up
- **Pro:** Keeps this work strictly about GitHub.
- **Con:** The abstraction is designed for it but goes unused. Someone has to pick the thread up later.

**Recommendation:** Option A. It is cheap, independent of the GitHub PRs, and fixes a broader problem with the same code. Moving the actual deployments to projected tokens stays a separate decision per deployment.
