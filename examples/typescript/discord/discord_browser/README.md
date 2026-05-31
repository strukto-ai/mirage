# Browser Discord demo

<p align="center">
  <a href="https://github.com/strukto-ai/mirage#readme"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.fr.md"><img alt="README en Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
</p>

Two-part demo of the browser `DiscordResource` pattern. The browser package never sees the bot token directly — instead, a small Node proxy holds the token and forwards requests to the Discord API. This same shape works for a real frontend (the proxy lives on your server, the browser hits a relative path).

## Run

In one terminal, start the proxy server (holds `DISCORD_BOT_TOKEN`):

```bash
pnpm tsx examples/typescript/discord/discord_browser/server.ts
```

In another terminal, run the demo (uses `@struktoai/mirage-browser` against the proxy URL):

```bash
pnpm tsx examples/typescript/discord/discord_browser/main.ts
```

`DISCORD_BOT_TOKEN` must be set in the proxy server's environment (e.g. via `.env.development` at the repo root). Override the proxy URL by setting `DISCORD_PROXY_URL` in the demo's environment.
