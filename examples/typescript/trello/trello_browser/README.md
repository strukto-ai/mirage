# Browser Trello demo

<p align="center">
  <a href="https://github.com/strukto-ai/mirage#readme"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.fr.md"><img alt="README en Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
</p>

Demonstrates the browser `TrelloResource` calling `api.trello.com` directly — no proxy server. Trello's REST API supports CORS and uses URL-param auth, so the browser can talk to it directly (mirroring how the browser `S3Resource` signs requests with credentials it holds).

## Run

```bash
pnpm tsx examples/typescript/trello/trello_browser/main.ts
```

`TRELLO_API_KEY` and `TRELLO_API_TOKEN` must be set (e.g. via `.env.development` at the repo root).

## Production note

Embedding `apiKey` + `apiToken` in shipped client code is fine for personal tools, internal dashboards, or post-OAuth flows where the token is already user-scoped. For untrusted clients, route through your own server using the `baseUrl` config option to point at a proxy that injects the credentials server-side.
