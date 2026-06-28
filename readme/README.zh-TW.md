<p align="center">
  <img src="../assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的統一虛擬檔案系統" width="900">
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
  <a href="../README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./README.fr.md"><img alt="README en Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="./README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage 是 **面向 AI Agent 的統一虛擬檔案系統**：它把 S3、Google Drive、Slack、Gmail、Redis 等服務和資料來源並排掛載為同一個檔案系統。任何已經會用 bash 的 LLM 都可以開箱即用地對每個後端進行讀取、grep 和管線操作，不需要學習新的詞彙。

```ts
const ws = new Workspace({
  '/data':  new RAMResource(),
  '/s3':    new S3Resource({ bucket: 'logs' }),
  '/slack': new SlackResource({ token: process.env.SLACK_BOT_TOKEN! }),
})

await ws.execute('grep -r alert /slack/channels/general__C04QX/ | wc -l')
await ws.execute('cp /s3/report.csv /data/local.csv')
await ws.execute('wc -l $(find /s3/data -name "*.jsonl")')

// 命令是可擴充的：可以註冊新命令，也可以針對特定資源 + 檔案類型
// 覆寫某個命令，例如對 S3 上的 Parquet 檔案執行 `cat` 會把資料列渲染為 JSON。
ws.command('summarize', ...)
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /data/local.csv')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## 關於

- **一個介面，而不是 N 個 SDK 和 M 個 MCP。** 每個服務都使用同一套檔案系統語意，管線可以像在本機磁碟上一樣跨服務組合。
- **約 50 個內建後端：** RAM、Disk、Redis、S3 / R2 / OCI / Supabase / GCS、Gmail / GDrive / GDocs / GSheets / GSlides、GitHub / Linear / Notion / Trello、Slack / Discord / Email、MongoDB / Postgres / LanceDB、SSH 等，並排掛載在同一個根目錄下。
- **可攜的工作區：** 克隆、快照和版本化工作區；Agent 執行可以在機器之間遷移，而不必重啟或重新設定系統。
- **可嵌入：** Python 和 TypeScript SDK 直接執行在 FastAPI、Express、瀏覽器應用或任何非同步執行環境的行程內，不需要獨立的行程。
- **Agent 整合：** 透過 SDK 支援 OpenAI Agents SDK、Vercel AI SDK、LangChain、Pydantic AI、CAMEL 和 OpenHands；透過輕量 CLI + daemon 支援 Claude Code 和 Codex 等編碼 Agent。

## 架構

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 架構：AI Agent 和應用 → Mirage Bash 與 VFS → Dispatcher 與 Cache → 基礎設施和遠端服務" width="720">
  </picture>
</p>

## 安裝

- **Python** ≥ 3.11，用於 `mirage-ai` 套件和 `mirage` CLI
- **Node.js** ≥ 20，用於 TypeScript SDK
- **macOS** 或 **Linux**（基於 FUSE 的掛載需要平台支援）

### Python

```bash
uv add mirage-ai    # 安裝 `mirage` 函式庫和 `mirage` CLI 執行檔
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js 伺服器和 CLI
npm install @struktoai/mirage-browser   # 瀏覽器 / edge 執行環境
npm install @struktoai/mirage-agents    # OpenAI / Vercel AI / LangChain / Mastra 介接器
```

兩個執行環境套件都會自動引入 `@struktoai/mirage-core`。

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

## 快速開始

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

Mirage 可以作為沙箱或工具層接入 Agent 框架。`read` 等 POSIX 操作也可以按資源和檔案類型自訂，例如讀取 PDF 會回傳解析後的頁面，而不是原始位元組。

|            | 整合                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python     | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents)、[LangChain](https://docs.mirage.strukto.ai/python/agents/langchain)、[Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai)、[CAMEL](https://docs.mirage.strukto.ai/python/agents/camel)、[OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands)、[Agno](https://docs.mirage.strukto.ai/python/agents/agno) |
| TypeScript | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel)、[OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai)、[LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain)、[Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                         |
| 編碼 Agent | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code)、[Codex](https://docs.mirage.strukto.ai/python/agents/codex)、[OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode)、[Pi](https://docs.mirage.strukto.ai/typescript/agents/pi)                                                                                                                                                     |

## 快取

每個 `Workspace` 都有兩層快取，讓針對遠端後端的重複操作命中本機狀態而不是網路：

- **索引快取：** 目錄列表和中繼資料。第一次遍歷目錄會呼叫 API；之後在 TTL 過期前（預設 10 分鐘）都從索引讀取。
- **檔案快取：** 物件位元組。第一次讀取從來源端串流拉取；之後的管線直接讀快取（預設 512 MB）。

兩層預設都使用行程內 RAM，零設定。Redis 儲存可以在 worker、行程和機器之間共享快取狀態：

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

完整的 miss/hit 生命週期見[快取文件](https://docs.mirage.strukto.ai/home/cache)。

## 貢獻者

感謝所有為 Mirage 做出貢獻的人。

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 貢獻者" />
</a>
