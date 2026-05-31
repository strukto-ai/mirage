# OpenHands + Mirage — agents that just use a shell

This example wires the OpenHands SDK to a Mirage `Workspace` and gives the agent **one** tool: `terminal`. No SaaS-specific tools, no MCP servers, no per-vendor schemas. Slack, S3, Gmail, GitHub, Linear — Mirage mounts each as a directory tree, and the agent treats them like a filesystem.

## Run

```bash
./python/.venv/bin/python examples/python/agents/openhands/sandbox_agent.py
```

The task: *"Find Slack messages containing 'hello' in #general."* The agent finishes in **2 commands**:

```
$ ls /slack/channels/
general__C04KEPWF6V7  random__C04JVGZM7UN  test__C0AS76ABXMK

$ grep -i hello /slack/channels/general__C04KEPWF6V7/*.jsonl
.../2026-04-16.jsonl:[zechengzhang97] hello
.../2026-04-04.jsonl:[demo app] Hello from MIRAGE Slack provider!
```

That's it. The agent never learned about Slack's API. It used `ls` and `grep`.

## Why this matters: Mirage vs. the alternatives

The same task, three ways. Same answer; very different agent surface.

### With Mirage (this example)

- **Agent's tool list:** `terminal`. One tool, one schema.
- **Agent's vocabulary:** every shell command it already knows — `ls`, `cat`, `grep`, `head`, `wc`, `jq`, `find`, pipes, redirection.
- **What changed when we added Slack:** mount it at `/slack`. No new tools, no new prompts, no new agent code.

### With a Slack MCP server

- **Agent's tool list:** typically 6–12 Slack-specific tools — `slack_search_messages`, `slack_list_channels`, `slack_get_channel_history`, `slack_get_user_info`, `slack_post_message`, `slack_add_reaction`, …
- **Agent's vocabulary per tool:** every tool has its own JSON schema, parameter names, return shape. The model has to *learn the API*, then translate user intent into the right tool + the right params.
- **Composition:** want to filter messages with `jq` then count with `wc`? You can't — MCP tools are atomic; you get back what they return.
- **Adding Discord:** another MCP server with its own 6–12 tools. The agent's prompt now juggles two parallel APIs.

### With the Slack CLI

- **Agent's tool list:** `terminal` (good — same as Mirage), but...
- **Agent's vocabulary:** `slack search ...`, `slack chat send ...`, `slack auth login ...`. Vendor-specific subcommands, vendor-specific output formats, vendor-specific auth handling. The agent has to know the Slack CLI exists *and* how to invoke it.
- **Composition:** the CLI's stdout is its own format. Pipe it through `jq` if it happens to emit JSON, otherwise parse text.
- **Adding Discord:** install the Discord CLI. Now the agent needs to know two CLIs and pick correctly.

### Side-by-side

|                                        | Mirage                                                                                                  | Slack MCP                                   | Slack CLI                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| Tools the agent sees                   | 1 (`terminal`)                                                                                          | 6–12 per backend                            | 1 (`terminal`)                           |
| Vocabulary the agent must learn        | shell + Mirage's filesystem layout                                                                      | each tool's schema                          | each CLI's subcommand grammar            |
| Composability (pipe / redirect / loop) | yes — real shell                                                                                        | no — atomic calls                           | partial — depends on CLI's stdout format |
| Adding a new backend                   | mount it; nothing else changes                                                                          | new MCP server, new tool list, prompt churn | install new CLI; agent must learn it     |
| Pushdown to native APIs (search, etc.) | automatic, in the builtin (Mirage rewrites `grep` over a Slack channel into one `search.messages` call) | only what the MCP exposes                   | none — text in, text out                 |

## What Mirage gives the agent

- **One stable tool surface** (`terminal`) regardless of how many backends are mounted.
- **Pipes and composability** because everything is a stream of bytes — `cat /s3/data/2026-04.parquet | grep error | jq '.user' | sort | uniq -c`.
- **Format-aware reads** — `cat` on `.parquet` / `.feather` / `.orc` returns a formatted table; `head -n 5` on `.jsonl` returns the first 5 messages; `grep` on a Slack channel directory pushes down to `search.messages` automatically.
- **One mental model** for the agent: *"the workspace is a filesystem; use shell."*
- **One mental model** for you: *"if I can mount it, the agent can use it."*

## Configure

The script loads `.env.development` from the repo root. Required:

| Var                                                                                 | What it's for                                                                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_API_KEY`                                                                       | OpenHands `LLM` (defaults to Anthropic — set to your `ANTHROPIC_API_KEY`)                                                                          |
| `AWS_S3_BUCKET`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `/s3` mount                                                                                                                                        |
| `SLACK_BOT_TOKEN`                                                                   | `/slack` mount                                                                                                                                     |
| `SLACK_USER_TOKEN` *(recommended)*                                                  | enables Slack's `search.messages` push-down so `grep` over `/slack/channels/<channel>/*.jsonl` runs in one API call instead of fanning out per day |
