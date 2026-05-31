# Browser GitHub demo

Demonstrates the browser `GitHubResource` calling `api.github.com` directly — no proxy server. GitHub's REST API supports CORS and uses an `Authorization` header, so the browser can talk to it directly (same model as Linear).

## Run

```bash
pnpm tsx examples/typescript/github/github_browser/main.ts
```

`GITHUB_TOKEN` must be set (e.g. via `.env.development` at the repo root). Optional: `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_REF`.

## Production note

Embedding a personal access token in shipped client code is fine for personal tools, internal dashboards, or post-OAuth flows where the token is already user-scoped. For untrusted clients, route through your own server using the `baseUrl` config option to point at a proxy that injects the credential server-side.
