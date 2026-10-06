# e2b

Manual checks against a live E2B sandbox, outside the runners. The `e2b`
cases themselves live in `sandbox/` and run in CI against E2B Embed.

| File         | Checks                                                                                            | Needs                      |
| ------------ | ------------------------------------------------------------------------------------------------- | -------------------------- |
| `live.py`    | creates a sandbox, then the runtime, SSH transport, shared SFTP files and MCP over one connection | `E2B_API_KEY`              |
| `live.ts`    | the TypeScript half, run by `live.py`                                                             | the sandbox `live.py` made |
| `browser.ts` | the browser bundle runs a sandbox from Chromium                                                   | `E2B_API_KEY`, Chromium    |
| `install.ts` | a minimal install bundles the browser package without E2B                                         | run by `test_install.yml`  |
