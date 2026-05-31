<p align="center">
  <img src="assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的統一虛擬檔案系統" width="900">
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="文件">
        <img src="https://img.shields.io/badge/mirage-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="官網">
        <img src="https://img.shields.io/badge/strukto.ai-%E5%87%BA%E5%93%81-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="授權條款">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord 社群">
        <img src="https://img.shields.io/badge/discord-%E5%8A%A0%E5%85%A5-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Python 文件">
        <img src="https://img.shields.io/badge/python-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA&logo=python&logoColor=0C0C0C" alt="Python 文件"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="PyPI 版本">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="TypeScript 文件">
        <img src="https://img.shields.io/badge/typescript-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA&logo=typescript&logoColor=0C0C0C" alt="TypeScript 文件"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-node" alt="NPM 版本">
        <img src="https://img.shields.io/npm/v/@struktoai/mirage-node.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
</p>

<p align="center">
  <a href="./README.md"><img alt="英文 README" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="簡體中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./README.fr.md"><img alt="法文 README" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="越南文 README" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
</p>

Mirage 是 **面向 AI Agent 的統一虛擬檔案系統**：它把 S3、Google Drive、Slack、Gmail、Redis 等服務和資料源並排掛載到同一棵檔案樹中。

AI Agent 只需要使用同一組类 Unix 工具就能存取每個後端，管線也能像在本機磁碟上一樣跨服務組合。它是一个模擬環境，Agent 看到的是底層的同一个檔案系統。任何已经会用 bash 的 LLM 都可以直接使用 Mirage，不需要學習新的詞彙。

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

// 註冊一个新命令，可用於所有掛載点。
ws.command('summarize', ...)

// 針對特定資源和檔案型別覆寫命令。
// 在 /s3 中对 Parquet 檔案執行 `cat` 会把行渲染为 JSON，而不是原始位元組。
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /github/mirage/README.md')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## 關於

- **一个檔案系統，連接所有後端。** 每個服務都使用同一套檔案系統語意，所以 Agent 只需要理解一个抽象，而不是 N 个 SDK 和 M 个 MCP；它依靠的是 LLM 最熟悉的檔案系統和 bash 詞彙。
- **多個資源，一个檔案系統：** RAM、Disk、Redis、S3 / R2 / OCI / Supabase / GCS、Gmail / GDrive / GDocs / GSheets / GSlides、GitHub / Linear / Notion / Trello、Slack / Discord / Telegram / Email、MongoDB、SSH 等資源，都可以並排掛載在同一个根目錄下。
- **每個掛載点都能使用熟悉的 bash 工具。** Agent 复用同一組类 Unix 工具，而不是为每個服務學習一套新 API；管線可以像在本機磁碟上一樣跨服務組合，这正是現代 LLM 訓練語料中最熟悉的操作模式。
- **可攜式的工作區：** 複製、快照和版本化你的環境。可以在機器之間遷移 Agent 執行，而不必重新啟動或重新設定系統。
- **嵌入你的應用和服務：** Python 和 TypeScript SDK 可以把虛擬檔案系統直接交给 FastAPI、Express、瀏覽器應用或任何非同步執行環境中的 AI Agent 使用，不需要单独的程序。你也可以在程式碼里複製、快照和版本化工作區。
- **相容主流 Agent 應用框架：** OpenAI Agents SDK、Vercel AI SDK (TypeScript)、LangChain、Pydantic AI、CAMEL 和 OpenHands。
- **輕量 CLI + daemon：** 可接入 Claude Code 和 Codex 等編碼 Agent，让它们透過熟悉的 bash 存取所有已掛載資源，每一轮都能完成更有用的工作。

## 架構

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mirage-arch-dark.svg">
    <img src="assets/mirage-arch-light.svg" alt="Mirage 架構：AI Agent 和應用 → Mirage Bash 与 VFS → Dispatcher 与 Cache → 基礎設施和遠端服務" width="900">
  </picture>
</p>

## 安裝

### 前置條件

- **Python** ≥ 3.12，用於 `mirage-ai` 套件和 `mirage` CLI
- **Node.js** ≥ 20，用於 TypeScript SDK
- **macOS** 或 **Linux**（基于 FUSE 的掛載需要平台支援）

### Python

```bash
uv add mirage-ai
```

这会同时安裝 `mirage` 库和 `mirage` CLI 執行檔案。

### TypeScript

選擇与你的執行環境相符的套件：

```bash
npm install @struktoai/mirage-node      # Node.js 伺服器端和 CLI
npm install @struktoai/mirage-browser   # 瀏覽器 / 边缘執行環境
npm install @struktoai/mirage-core      # 執行環境无关的基础能力
```

`@struktoai/mirage-node` 和 `@struktoai/mirage-browser` 都会自動引入 `@struktoai/mirage-core`。

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
```

或者使用你喜欢的套件管理器：

```bash
npm install -g @struktoai/mirage-cli
```

```bash
uvx mirage-ai
```

```bash
npx @struktoai/mirage-cli
```

## 快速開始 (Python)

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

## 快速開始 (TypeScript)

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

## 快速開始 (CLI)

```bash
mirage workspace create ws.yaml --id demo
mirage execute   --workspace_id demo --command "cp /s3/report.csv /data/report.csv"
mirage provision --workspace_id demo --command "cat /s3/data/large.jsonl"
mirage workspace snapshot demo demo.tar
mirage workspace load demo.tar --id demo-restored
```

## Agent 框架

Mirage 可以作为沙箱或工具层接入主流 Agent 應用框架。Agent 会面对与 bash 中相同的掛載樹，因此替换模型或執行環境都不会改变操作界面。

### OpenAI Agents SDK (Python)

`MirageSandboxClient` 会把 `Workspace` 作为沙箱接入 OpenAI Agents SDK：Agent 執行的 bash 命令会在你的掛載資源上執行。

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
    "将 /s3/data/report.parquet 摘要到 /report.txt。",
    run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
)
```

### Vercel AI SDK (TypeScript)

`mirageTools(ws)` 会把工作區暴露为一組型別化的 AI SDK 工具，因此任何接入 AI SDK 的模型都能在 Node.js 或瀏覽器中跨掛載点讀寫。

```ts
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { mirageTools } from '@struktoai/mirage-agents/vercel'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'

const { text } = await generateText({
  model: openai('gpt-5.4-nano'),
  system: buildSystemPrompt({ mountInfo: { '/': '内存檔案系統' } }),
  prompt: "使用 readFile 讀取 /docs/paper.pdf，然后描述其中的內容。",
  tools: mirageTools(ws),
})
```

LangChain、Pydantic AI、CAMEL、OpenHands 和 Mastra 轉接器也在同一套生態中。

## 快取

每個 `Workspace` 都內建 **兩層快取**，这样对遠端後端（S3、GDrive、Slack 等）的重複操作会命中本機狀態，而不是反复存取網路：

- **索引快取。** 快取目錄列表和中繼資料。第一次目錄遍歷会存取 API，之后在 TTL 過期前都从索引回傳。
- **檔案快取。** 快取物件位元組。第一次讀取会从源端串流讀取，後續管線直接从快取讀取。
- **可插拔後端。** 每一层都是一个儲存，內建两个實作：
  - **RAM**（預設）：程序内、零設定、512 MB 檔案快取和 10 分鐘索引 TTL。適合單程序應用和笔记本環境。
  - **Redis**：可在工作程序、程序和機器之間共享。適合serverless、多副本服務，或需要快取狀態跨重啟保留的场景。

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

// 1. 索引未命中 → S3 LIST。列表会存入索引快取。
await ws.execute('ls /s3/data/')

// 2. 索引命中 → 0 次網路呼叫。
await ws.execute('find /s3/data/ -name "*.jsonl"')

// 3. 檔案未命中 → S3 GET。位元組会存入檔案快取。
await ws.execute('cat /s3/data/log.jsonl | wc -l')

// 4. 檔案命中 → 0 次網路呼叫。
await ws.execute('grep alert /s3/data/log.jsonl')
```

## 貢獻者

感謝所有为 Mirage 做出贡献的人。

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 貢獻者" />
</a>
