# Browser Discord demo

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
