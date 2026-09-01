<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的虚拟终端" width="900">
  </picture>
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
  <a href="./README.de.md"><img alt="README auf Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="./README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage 是 **面向 AI Agent 的虚拟终端**。虚拟文件系统提供广泛的数据上下文，虚拟化 CLI 让 Agent 在工具使用上更灵活，动态运行时降低底层基础设施成本并且更节省 token，而对 Agent 行为乃至其可见范围的细粒度控制带来最好的安全性。这些部分共同构成一个虚拟化终端，带来最好的 Agent 性能、成本效率和安全性。

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
await ws.execute("python3 /slack/channels/general_.../files/example__F....py > /redis/report.txt")

# 以头部命令名安装一个类型化 CLI：按名称分发，而不是按路径，
# 并且像其他程序一样可以通过 `man`、`type`、`which` 发现
ws.register_cli("slack", SLACK, {"token": slack_bot_token})
await ws.execute('slack send-message --channel general --text "report is up"')
```

## 关于

- **统一的虚拟终端接口，而不是 N 个 SDK 和 M 个 MCP。** 每个后端都使用同一套文件系统语义，管道可以跨服务组合。
- **覆盖所有数据源的虚拟文件系统。** S3、Google Drive、Slack、Gmail、Redis 等并排挂载在同一个根目录下，Agent 通过统一接口，用它已经会的 unix 工具（如 `ls`、`grep`、`find` 和 `jq`）访问全部数据源。
- **虚拟命令行工具（CLI）。** `git`、`slack` 和 `ntn` 由 Mirage 自己应答，Agent 无需安装任何东西即可驱动这些服务，并可跨不同运行时和机器；同一个工具还能虚拟成两个或更多，各自使用独立的名称和凭据。
- **动态路由的运行时。** Python、JavaScript 以及任何其他命令都可以被发送到所配置的运行时，进程内、沙箱或远程，从而把计算与存储解耦，任何一方都可以独立更换。
- **虚拟化的 Mirage Shell。** 它把文件系统、CLI 和运行时绑定到同一条命令行上，因此管道、重定向、变量、作业和历史记录在三者之间都可用。
- **为 Agent 设计的 Profile。** `allow`、`ask` 和 `deny` 管控命令和 CLI，`hide` 和 `show` 管控文件和目录，因此被隐藏的路径不只是不可读，而是在 Agent 看到的文件系统中根本不存在。
- **可脚本化的策略引擎。** 策略脚本可以在任何危险操作执行前将其阻止，同一套策略栈还会拦截每一次 VFS 操作和会话写入，因此文件和环境变量都不会泄露。
- **接入 VFS 与 Agent 的通知。** 外部变更会成为挂载上的事件流，因此一条新的 Slack 回复会表现为虚拟文件系统中聊天文件的变化，Agent 直接据此响应，而不必重新扫描整棵树。

## 架构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 架构：Agent 与 Harness 连接 Profile 和 Mirage Shell，二者把类 Unix 命令、虚拟 CLI 和编程语言解析到运行时与虚拟文件系统上，认证、策略引擎和通知在旁" width="100%">
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
