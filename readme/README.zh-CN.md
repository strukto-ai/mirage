<p align="center">
  <img src="../assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的统一虚拟文件系统" width="900">
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
  <a href="../README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./README.fr.md"><img alt="README en Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="./README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage 是 **面向 AI Agent 的统一虚拟文件系统**：它把 S3、Google Drive、Slack、Gmail、Redis 等服务和数据源并排挂载为同一个文件系统。任何已经会用 bash 的 LLM 都可以开箱即用地对每个后端进行读取、grep 和管道操作，不需要学习新的词汇。

```python
ws = Workspace(
    {
        "/tmp":   (RAMResource(), MountMode.EXEC),
        "/redis": (RedisResource(url=redis_url), MountMode.WRITE),
        "/slack": (SlackResource(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
    },
    # monty 捕获 python，脚本在工作区内以沙箱方式运行
    runtimes=[MontyRuntime(captures=["python", "python3"]), "vfs"],
)

# 一次 grep 扫遍所有数据源
await ws.execute("grep -rln session /redis /tmp")

# 运行存放在 Slack 里的脚本，把报告写入 Redis
await ws.execute(
    "python3 /slack/channels/general__C0.../files/example__F0....py > /redis/report.txt"
)

# 以头部命令名安装一个类型化 CLI：按名称分发，而不是按路径，
# 并且像其他程序一样可以通过 `man`、`type`、`which` 发现
ws.register_cli("slack", SLACK, {"token": slack_bot_token})
await ws.execute('slack send-message --channel general --text "report is up"')
```

## 关于

- **一个接口，而不是 N 个 SDK 和 M 个 MCP。** 每个服务都使用同一套文件系统语义，管道可以像在本地磁盘上一样跨服务组合。
- **约 50 个内置后端：** RAM、Disk、Redis、S3 / R2 / OCI / Supabase / GCS、Gmail / GDrive / GDocs / GSheets / GSlides、GitHub / Linear / Notion / Trello、Slack / Discord / Email、MongoDB / GridFS / Postgres / LanceDB / Qdrant、SSH 等，并排挂载在同一个根目录下。
- **可移植的工作区：** 克隆、快照和版本化工作区；Agent 运行可以在机器之间迁移，而不必重启或重新配置系统。
- **可嵌入：** Python 和 TypeScript SDK 直接运行在 FastAPI、Express、浏览器应用或任何异步运行时的进程内，不需要单独的进程。
- **Agent 集成：** 通过 SDK 支持 OpenAI Agents SDK、Vercel AI SDK、LangChain、Pydantic AI、CAMEL 和 OpenHands；编码 Agent 则通过原生适配器、可安装插件、MCP 或 FUSE 接入。

## 架构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 架构：AI Agent 和应用 → Mirage Bash 与 VFS → Dispatcher 与 Cache → 基础设施和远程服务" width="720">
  </picture>
</p>

## 安装

- **Python** ≥ 3.11，用于 `mirage-ai` 包和 `mirage` CLI
- **Node.js** ≥ 20，用于 TypeScript SDK
- **macOS** 或 **Linux**（基于 FUSE 的挂载需要平台支持）

### Python

```bash
uv add mirage-ai    # 安装 `mirage` 库和 `mirage` CLI 二进制
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js 服务器和 CLI
npm install @struktoai/mirage-browser   # 浏览器 / edge 运行时
npm install @struktoai/mirage-agents    # OpenAI / Vercel AI / LangChain / Mastra 适配器
```

两个运行时包都会自动引入 `@struktoai/mirage-core`。

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
# 或
npm install -g @struktoai/mirage-cli
# 或
uvx mirage-ai
# 或
npx @struktoai/mirage-cli
```

## 快速开始

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
  '/s3':   new S3Resource({ bucket: 'my-bucket' }),
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

## Agent 框架

Mirage 可以作为沙箱或工具层接入 Agent 框架。`read` 等 POSIX 操作也可以按资源和文件类型自定义：Mirage 不内置任何文件类型渲染器，因此某种格式如何渲染完全取决于你注册的实现，而针对特定资源和扩展名注册的命令优先于通用命令。

|            | 集成                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python     | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents)、[LangChain](https://docs.mirage.strukto.ai/python/agents/langchain)、[Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai)、[CAMEL](https://docs.mirage.strukto.ai/python/agents/camel)、[OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands)、[Agno](https://docs.mirage.strukto.ai/python/agents/agno)      |
| TypeScript | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel)、[OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai)、[LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain)、[Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                              |
| 编码 Agent | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code)、[Codex](https://docs.mirage.strukto.ai/typescript/agents/codex)、[DeepSeek Harness](https://docs.mirage.strukto.ai/typescript/agents/dsh)、[Grok Build](https://docs.mirage.strukto.ai/typescript/agents/grok-build)、[OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode)、[Pi](https://docs.mirage.strukto.ai/typescript/agents/pi) |

## 缓存

每个 `Workspace` 都有两层缓存，让针对远端后端的重复操作命中本地状态而不是网络：

- **索引缓存：** 目录列表和元数据。第一次遍历目录会调用 API；之后在 TTL 过期前（默认 10 分钟）都从索引读取。
- **文件缓存：** 对象字节。第一次读取从源端流式拉取；之后的管道直接读缓存（默认 512 MB）。

两层默认都使用进程内 RAM，零配置。Redis 存储可以在 worker、进程和机器之间共享缓存状态：

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

完整的 miss/hit 生命周期见[缓存文档](https://docs.mirage.strukto.ai/home/cache)。

## 贡献者

感谢所有为 Mirage 做出贡献的人。

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 贡献者" />
</a>
