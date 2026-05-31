# Browser Trello demo

Demonstrates the browser `TrelloResource` calling `api.trello.com` directly — no proxy server. Trello's REST API supports CORS and uses URL-param auth, so the browser can talk to it directly (mirroring how the browser `S3Resource` signs requests with credentials it holds).

## Run

```bash
pnpm tsx examples/typescript/trello/trello_browser/main.ts
```

`TRELLO_API_KEY` and `TRELLO_API_TOKEN` must be set (e.g. via `.env.development` at the repo root).

## Production note

Embedding `apiKey` + `apiToken` in shipped client code is fine for personal tools, internal dashboards, or post-OAuth flows where the token is already user-scoped. For untrusted clients, route through your own server using the `baseUrl` config option to point at a proxy that injects the credentials server-side.
