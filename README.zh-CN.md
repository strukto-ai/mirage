<p align="center">
  <img src="assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的统一虚拟文件系统" width="900">
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="文档">
        <img src="https://img.shields.io/badge/mirage-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="官网">
        <img src="https://img.shields.io/badge/strukto.ai-%E5%87%BA%E5%93%81-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="许可证">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord 社区">
        <img src="https://img.shields.io/badge/discord-%E5%8A%A0%E5%85%A5-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Python 文档">
        <img src="https://img.shields.io/badge/python-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA&logo=python&logoColor=0C0C0C" alt="Python 文档"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="PyPI 版本">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="TypeScript 文档">
        <img src="https://img.shields.io/badge/typescript-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA&logo=typescript&logoColor=0C0C0C" alt="TypeScript 文档"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-node" alt="NPM 版本">
        <img src="https://img.shields.io/npm/v/@struktoai/mirage-node.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
</p>

<p align="center">
  <a href="./README.md"><img alt="英文 README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./README.fr.md"><img alt="法语 README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="越南语 README" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
</p>

Mirage 是 **面向 AI Agent 的统一虚拟文件系统**：它把 S3、Google Drive、Slack、Gmail、Redis 等服务和数据源并排挂载到同一棵文件树中。

AI Agent 只需要使用同一组类 Unix 工具就能访问每个后端，管道也能像在本地磁盘上一样跨服务组合。它是一个模拟环境，Agent 看到的是底层的同一个文件系统。任何已经会用 bash 的 LLM 都可以直接使用 Mirage，不需要学习新的词汇。

```ts
const ws = new Workspace({
  '/data':   new RAMResource(),
  '/s3':     new S3Resource({ bucket: 'logs' }),
  '/slack':  new SlackResource({}),
  '/github': new GitHubResource({}),
})

await ws.execute('grep alert /slack/general/*.json | wc -l')
await ws.execute('cat /github/mirage/README.md')
await ws.execute('cp /s3/report.csv /data/local.csv')

// 注册一个新命令，可用于所有挂载点。
ws.command('summarize', ...)

// 针对特定资源和文件类型覆盖命令。
// 在 /s3 中对 Parquet 文件执行 `cat` 会把行渲染为 JSON，而不是原始字节。
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /github/mirage/README.md')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## 关于

- **一个文件系统，连接所有后端。** 每个服务都使用同一套文件系统语义，所以 Agent 只需要理解一个抽象，而不是 N 个 SDK 和 M 个 MCP；它依靠的是 LLM 最熟悉的文件系统和 bash 词汇。
- **多个资源，一个文件系统：** RAM、Disk、Redis、S3 / R2 / OCI / Supabase / GCS、Gmail / GDrive / GDocs / GSheets / GSlides、GitHub / Linear / Notion / Trello、Slack / Discord / Telegram / Email、MongoDB、SSH 等资源，都可以并排挂载在同一个根目录下。
- **每个挂载点都能使用熟悉的 bash 工具。** Agent 复用同一组类 Unix 工具，而不是为每个服务学习一套新 API；管道可以像在本地磁盘上一样跨服务组合，这正是现代 LLM 训练语料中最熟悉的操作模式。
- **可移植的工作区：** 克隆、快照和版本化你的环境。可以在机器之间迁移 Agent 运行，而不必重新启动或重新配置系统。
- **嵌入你的应用和服务：** Python 和 TypeScript SDK 可以把虚拟文件系统直接交给 FastAPI、Express、浏览器应用或任何异步运行时中的 AI Agent 使用，不需要单独的进程。你也可以在代码里克隆、快照和版本化工作区。
- **兼容主流 Agent 应用框架：** OpenAI Agents SDK、Vercel AI SDK (TypeScript)、LangChain、Pydantic AI、CAMEL 和 OpenHands。
- **轻量 CLI + daemon：** 可接入 Claude Code 和 Codex 等编码 Agent，让它们通过熟悉的 bash 访问所有已挂载资源，每一轮都能完成更有用的工作。

## 架构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mirage-arch-dark.svg">
    <img src="assets/mirage-arch-light.svg" alt="Mirage 架构：AI Agent 和应用 → Mirage Bash 与 VFS → Dispatcher 与 Cache → 基础设施和远程服务" width="900">
  </picture>
</p>

## 安装

### 前置条件

- **Python** ≥ 3.12，用于 `mirage-ai` 包和 `mirage` CLI
- **Node.js** ≥ 20，用于 TypeScript SDK
- **macOS** 或 **Linux**（基于 FUSE 的挂载需要平台支持）

### Python

```bash
uv add mirage-ai
```

这会同时安装 `mirage` 库和 `mirage` CLI 可执行文件。

### TypeScript

选择与你的运行时匹配的包：

```bash
npm install @struktoai/mirage-node      # Node.js 服务端和 CLI
npm install @struktoai/mirage-browser   # 浏览器 / 边缘运行时
npm install @struktoai/mirage-core      # 运行时无关的基础能力
```

`@struktoai/mirage-node` 和 `@struktoai/mirage-browser` 都会自动引入 `@struktoai/mirage-core`。

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
```

或者使用你喜欢的包管理器：

```bash
npm install -g @struktoai/mirage-cli
```

```bash
uvx mirage-ai
```

```bash
npx @struktoai/mirage-cli
```

## 快速开始 (Python)

```python
from mirage import Workspace
from mirage.resource.gdocs import GDocsConfig, GDocsResource
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.slack import SlackConfig, SlackResource

ws = Workspace({
    "/data":  RAMResource(),
    "/s3":    S3Resource(S3Config(bucket="my-bucket")),
    "/slack": SlackResource(SlackConfig()),
    "/docs":  GDocsResource(GDocsConfig()),
})

await ws.execute("cp /s3/report.csv /data/report.csv")
await ws.execute("grep alert /s3/data/log.jsonl | wc -l")

ws.snapshot("demo.tar")
```

## 快速开始 (TypeScript)

```ts
import {
  Workspace,
  RAMResource,
  S3Resource,
  SlackResource,
  GDocsResource,
} from '@struktoai/mirage-browser'

const ws = new Workspace({
  '/data':  new RAMResource(),
  '/s3':    new S3Resource({ bucket: 'my-bucket' }),
  '/slack': new SlackResource({}),
  '/docs':  new GDocsResource({}),
})

await ws.execute('cp /s3/report.csv /data/report.csv')
await ws.execute('grep alert /s3/data/log.jsonl | wc -l')
```

## 快速开始 (CLI)

```bash
mirage workspace create ws.yaml --id demo
mirage execute   --workspace_id demo --command "cp /s3/report.csv /data/report.csv"
mirage provision --workspace_id demo --command "cat /s3/data/large.jsonl"
mirage workspace snapshot demo demo.tar
mirage workspace load demo.tar --id demo-restored
```

## Agent 框架

Mirage 可以作为沙箱或工具层接入主流 Agent 应用框架。Agent 会面对与 bash 中相同的挂载树，因此替换模型或运行时都不会改变操作界面。

### OpenAI Agents SDK (Python)

`MirageSandboxClient` 会把 `Workspace` 作为沙箱接入 OpenAI Agents SDK：Agent 执行的 bash 命令会在你的挂载资源上运行。

```python
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig

from mirage.agents.openai_agents import MirageSandboxClient

client = MirageSandboxClient(ws)
agent = SandboxAgent(
    name="Mirage 沙箱 Agent",
    model="gpt-5.4-nano",
    instructions=ws.file_prompt,
)

result = await Runner.run(
    agent,
    "将 /s3/data/report.parquet 总结到 /report.txt。",
    run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
)
```

### Vercel AI SDK (TypeScript)

`mirageTools(ws)` 会把工作区暴露为一组类型化的 AI SDK 工具，因此任何接入 AI SDK 的模型都能在 Node.js 或浏览器中跨挂载点读写。

```ts
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { mirageTools } from '@struktoai/mirage-agents/vercel'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'

const { text } = await generateText({
  model: openai('gpt-5.4-nano'),
  system: buildSystemPrompt({ mountInfo: { '/': '内存文件系统' } }),
  prompt: "使用 readFile 读取 /docs/paper.pdf，然后描述其中的内容。",
  tools: mirageTools(ws),
})
```

LangChain、Pydantic AI、CAMEL、OpenHands 和 Mastra 适配器也在同一套生态中。

## 缓存

每个 `Workspace` 都内置 **两层缓存**，这样对远程后端（S3、GDrive、Slack 等）的重复操作会命中本地状态，而不是反复访问网络：

- **索引缓存。** 缓存目录列表和元数据。第一次目录遍历会访问 API，之后在 TTL 过期前都从索引返回。
- **文件缓存。** 缓存对象字节。第一次读取会从源端流式读取，后续管道直接从缓存读取。
- **可插拔后端。** 每一层都是一个存储，内置两个实现：
  - **RAM**（默认）：进程内、零配置、512 MB 文件缓存和 10 分钟索引 TTL。适合单进程应用和笔记本环境。
  - **Redis**：可在工作进程、进程和机器之间共享。适合无服务器、多副本服务，或需要缓存状态跨重启保留的场景。

```ts
import { RedisFileCacheStore, RedisIndexCacheStore, Workspace } from 'mirage/node'

const ws = new Workspace(
  { '/s3': new S3Resource({ bucket: 'my-bucket' }) },
  {
    cache: new RedisFileCacheStore({ url: 'redis://localhost:6379/0', limit: '8GB' }),
    index: new RedisIndexCacheStore({ url: 'redis://localhost:6379/0', ttl: 600 }),
  },
)
```

```ts
import { S3Resource, Workspace } from 'mirage/node'

const ws = new Workspace({ '/s3': new S3Resource({ bucket: 'my-bucket' }) })

// 1. 索引未命中 → S3 LIST。列表会存入索引缓存。
await ws.execute('ls /s3/data/')

// 2. 索引命中 → 0 次网络调用。
await ws.execute('find /s3/data/ -name "*.jsonl"')

// 3. 文件未命中 → S3 GET。字节会存入文件缓存。
await ws.execute('cat /s3/data/log.jsonl | wc -l')

// 4. 文件命中 → 0 次网络调用。
await ws.execute('grep alert /s3/data/log.jsonl')
```

## 贡献者

感谢所有为 Mirage 做出贡献的人。

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 贡献者" />
</a>
