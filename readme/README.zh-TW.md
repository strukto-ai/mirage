<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的虛擬終端機" width="900">
  </picture>
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
  <a href="./README.de.md"><img alt="README auf Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="./README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage 是 **面向 AI Agent 的虛擬終端機**。虛擬檔案系統提供廣泛的資料脈絡，虛擬化 CLI 讓 Agent 在工具使用上更靈活，動態執行環境降低底層基礎設施成本並且更節省 token，而對 Agent 行為乃至其可見範圍的細粒度控制帶來最好的安全性。這些部分共同構成一個虛擬化終端機，帶來最好的 Agent 效能、成本效率與安全性。

```python
ws = Workspace(
    {
        "/tmp":   (RAMResource(), MountMode.EXEC),
        "/redis": (RedisResource(url=redis_url), MountMode.WRITE),
        "/slack": (SlackResource(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
    },
    # monty 捕獲 python，腳本在工作區內以沙箱方式執行
    runtimes=[MontyRuntime(captures=["python", "python3"]), "vfs"],
)

# 一次 grep 掃遍所有資料來源
await ws.execute("grep -rln session /redis /tmp")

# 執行放在 Slack 裡的腳本，把報告寫入 Redis
await ws.execute("python3 /slack/channels/general_.../files/example__F....py > /redis/report.txt")

# 以頭部命令名安裝一個型別化 CLI：依名稱分派，而不是依路徑，
# 並且像其他程式一樣可以透過 `man`、`type`、`which` 發現
ws.register_cli("slack", SLACK, {"token": slack_bot_token})
await ws.execute('slack send-message --channel general --text "report is up"')
```

## 關於

- **統一的虛擬終端機介面，而不是 N 個 SDK 和 M 個 MCP。** 每個後端都使用同一套檔案系統語意，管線可以跨服務組合。
- **涵蓋所有資料來源的虛擬檔案系統。** S3、Google Drive、Slack、Gmail、Redis 等並排掛載在同一個根目錄下，Agent 透過統一介面，用它已經會的 unix 工具（如 `ls`、`grep`、`find` 和 `jq`）存取全部資料來源。
- **虛擬命令列工具（CLI）。** `git`、`slack` 和 `ntn` 由 Mirage 自己回應，Agent 無需安裝任何東西即可驅動這些服務，並可跨不同執行環境和機器；同一個工具還能虛擬成兩個或更多，各自使用獨立的名稱和憑證。
- **動態路由的執行環境。** Python、JavaScript 以及任何其他命令都可以被送到所設定的執行環境，行程內、沙箱或遠端，從而把運算與儲存解耦，任何一方都可以獨立更換。
- **虛擬化的 Mirage Shell。** 它把檔案系統、CLI 和執行環境綁定到同一條命令列上，因此管線、重新導向、變數、工作和歷史記錄在三者之間都可用。
- **為 Agent 設計的 Profile。** `allow`、`ask` 和 `deny` 管控命令和 CLI，`hide` 和 `show` 管控檔案和目錄，因此被隱藏的路徑不只是不可讀，而是在 Agent 看到的檔案系統中根本不存在。
- **可腳本化的策略引擎。** 策略腳本可以在任何危險操作執行前將其阻擋，同一套策略堆疊還會攔截每一次 VFS 操作和工作階段寫入，因此檔案和環境變數都不會外洩。
- **接入 VFS 與 Agent 的通知。** 外部變更會成為掛載上的事件串流，因此一則新的 Slack 回覆會表現為虛擬檔案系統中聊天檔案的變化，Agent 直接據此回應，而不必重新掃描整棵樹。

## 架構

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 架構：Agent 與 Harness 連接 Profile 和 Mirage Shell，兩者把類 Unix 命令、虛擬 CLI 和程式語言解析到執行環境與虛擬檔案系統上，認證、策略引擎和通知在旁" width="100%">
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

Mirage 可以作為沙箱或工具層接入 Agent 框架。`read` 等 POSIX 操作也可以按資源和檔案類型自訂：Mirage 不內建任何檔案類型渲染器，因此某種格式如何渲染完全取決於你註冊的實作，而針對特定資源和副檔名註冊的命令優先於通用命令。

|            | 整合                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python     | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents)、[LangChain](https://docs.mirage.strukto.ai/python/agents/langchain)、[Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai)、[CAMEL](https://docs.mirage.strukto.ai/python/agents/camel)、[OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands)、[Agno](https://docs.mirage.strukto.ai/python/agents/agno)      |
| TypeScript | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel)、[OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai)、[LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain)、[Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                              |
| 編碼 Agent | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code)、[Codex](https://docs.mirage.strukto.ai/typescript/agents/codex)、[DeepSeek Harness](https://docs.mirage.strukto.ai/typescript/agents/dsh)、[Grok Build](https://docs.mirage.strukto.ai/typescript/agents/grok-build)、[OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode)、[Pi](https://docs.mirage.strukto.ai/typescript/agents/pi) |

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
