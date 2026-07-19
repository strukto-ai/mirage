<p align="center">
  <img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/mirage-og-light@2x.png" alt="Mirage: A Unified Virtual File System for AI Agents" width="900">
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Documentation">
        <img src="https://img.shields.io/badge/mirage-docs-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="Website">
        <img src="https://img.shields.io/badge/made by-strukto.ai-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="License">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord">
        <img src="https://img.shields.io/badge/discord-join-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Python docs">
        <img src="https://img.shields.io/badge/python-docs-0C0C0C?labelColor=FAFAFA&logo=python&logoColor=0C0C0C" alt="Python docs"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="PyPI Version">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="TypeScript docs">
        <img src="https://img.shields.io/badge/typescript-docs-0C0C0C?labelColor=FAFAFA&logo=typescript&logoColor=0C0C0C" alt="TypeScript docs"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-agents" alt="NPM Version">
        <img src="https://img.shields.io/npm/v/%40struktoai%2Fmirage-agents.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
</p>

<p align="center">
  <a href="https://github.com/strukto-ai/mirage#readme"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.fr.md"><img alt="README en Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage is **a Unified Virtual File System for AI Agents**: it mounts services and data sources like S3, Google Drive, Slack, Gmail, and Redis side-by-side as one filesystem. Any LLM that already knows bash can read, grep, and pipe across every backend out of the box, with zero new vocabulary.

```ts
const ws = new Workspace({
  '/data':  new RAMResource(),
  '/s3':    new S3Resource({ bucket: 'logs' }),
  '/slack': new SlackResource({ token: process.env.SLACK_BOT_TOKEN! }),
})

await ws.execute('grep -r alert /slack/channels/general__C04QX/ | wc -l')
await ws.execute('cp /s3/report.csv /data/local.csv')
await ws.execute('wc -l $(find /s3/data -name "*.jsonl")')

// Commands are extensible: register new commands, or override one per
// resource + filetype, e.g. `cat` on S3 Parquet renders rows as JSON.
ws.command('summarize', ...)
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /data/local.csv')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## About

- **One interface instead of N SDKs and M MCPs.** Every service speaks the same filesystem semantics, and pipelines compose across services as naturally as on a local disk.
- **Around 50 built-in backends:** RAM, Disk, Redis, S3 / R2 / OCI / Supabase / GCS, Gmail / GDrive / GDocs / GSheets / GSlides, GitHub / Linear / Notion / Trello, Slack / Discord / Email, MongoDB / Postgres / LanceDB, SSH, and more, mounted side-by-side under a single root.
- **Portable workspaces:** clone, snapshot, and version a workspace; agent runs move between machines without restarting or reconfiguring the system.
- **Embeddable:** the Python and TypeScript SDKs run in-process inside FastAPI, Express, browser apps, or any async runtime; no separate process required.
- **Agent integrations:** OpenAI Agents SDK, Vercel AI SDK, LangChain, Pydantic AI, CAMEL, and OpenHands via the SDKs; coding agents through native adapters, installable plugins, MCP, or FUSE.

## Architecture

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/mirage-arch-dark.svg">
    <img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/mirage-arch-light.svg" alt="Mirage architecture: AI Agent and Application → Mirage Bash and VFS → Dispatcher &amp; Cache → Infrastructure and Remote" width="720">
  </picture>
</p>

## Installation

- **Python** ≥ 3.11 for the `mirage-ai` package and the `mirage` CLI
- **Node.js** ≥ 20 for the TypeScript SDK
- **macOS** or **Linux** (FUSE-based mounts require platform support)

### Python

```bash
uv add mirage-ai    # installs the `mirage` library and the `mirage` CLI binary
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js servers and CLIs
npm install @struktoai/mirage-browser   # browser / edge runtimes
npm install @struktoai/mirage-agents    # OpenAI / Vercel AI / LangChain / Mastra adapters
```

Both runtime packages pull in `@struktoai/mirage-core` automatically.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
# or
npm install -g @struktoai/mirage-cli
# or
uvx mirage-ai
# or
npx @struktoai/mirage-cli
```

## Quickstart

### Python

```python
from mirage import Workspace
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource

ws = Workspace({
    "/data": RAMResource(),
    "/s3":   S3Resource(S3Config(bucket="my-bucket")),
})

await ws.execute("cp /s3/report.csv /data/report.csv")
await ws.execute("grep alert /s3/data/log.jsonl | wc -l")

await ws.snapshot("demo.tar")
```

### TypeScript

```ts
import { Workspace, RAMResource, S3Resource } from '@struktoai/mirage-node'

const ws = new Workspace({
  '/data': new RAMResource(),
  '/s3': new S3Resource({ bucket: 'my-bucket' }),
})

await ws.execute('cp /s3/report.csv /data/report.csv')
await ws.execute('grep alert /s3/data/log.jsonl | wc -l')

await ws.snapshot('demo.tar')
```

### CLI

```bash
mirage workspace create ws.yaml --id demo
mirage execute   --workspace_id demo --command "cp /s3/report.csv /data/report.csv"
mirage provision --workspace_id demo --command "cat /s3/data/large.jsonl"
mirage workspace snapshot demo demo.tar
mirage workspace load demo.tar --id demo-restored
```

## Agent Frameworks

Mirage plugs into agent frameworks as a sandbox or tool layer. POSIX operations such as `read` can also be customized per resource and filetype, e.g. reading a PDF returns parsed pages instead of raw bytes.

|               | Integrations                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python        | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents), [LangChain](https://docs.mirage.strukto.ai/python/agents/langchain), [Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai), [CAMEL](https://docs.mirage.strukto.ai/python/agents/camel), [OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands), [Agno](https://docs.mirage.strukto.ai/python/agents/agno) |
| TypeScript    | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel), [OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai), [LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain), [Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                         |
| Coding agents | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code), [Codex](https://docs.mirage.strukto.ai/typescript/agents/codex), [Grok Build](https://docs.mirage.strukto.ai/typescript/agents/grok-build), [OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode), [Pi](https://docs.mirage.strukto.ai/typescript/agents/pi)                                                                      |

## Cache

Every `Workspace` has a two-layer cache so repeated work against remote backends hits local state instead of the network:

- **Index cache:** listings and metadata. The first directory walk hits the API; later ones serve from the index until the TTL expires (default 10 minutes).
- **File cache:** object bytes. The first read streams from origin; later pipelines read from cache (default 512 MB).

Both layers default to in-process RAM with zero setup. A Redis store shares cache state across workers, processes, and machines:

```ts
import { RedisFileCacheStore, S3Resource, Workspace } from '@struktoai/mirage-node'

const ws = new Workspace(
  { '/s3': new S3Resource({ bucket: 'my-bucket' }) },
  {
    cache: new RedisFileCacheStore({ url: 'redis://localhost:6379/0', cacheLimit: '8GB' }),
    index: { type: 'redis', url: 'redis://localhost:6379/0', ttl: 600 },
  },
)
```

See the [cache docs](https://docs.mirage.strukto.ai/home/cache) for the full miss/hit lifecycle.
