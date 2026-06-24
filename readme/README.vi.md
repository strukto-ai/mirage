<p align="center">
  <img src="../assets/mirage-og-light@2x.png" alt="Mirage: hệ thống tệp ảo thống nhất cho AI Agent" width="900">
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Tài liệu">
        <img src="https://img.shields.io/badge/mirage-t%C3%A0i%20li%E1%BB%87u-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="Trang web">
        <img src="https://img.shields.io/badge/t%E1%BA%A1o%20b%E1%BB%9Fi-strukto.ai-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="Giấy phép">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=gi%E1%BA%A5y%20ph%C3%A9p&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Cộng đồng Discord">
        <img src="https://img.shields.io/badge/discord-tham%20gia-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Tài liệu Python">
        <img src="https://img.shields.io/badge/python-t%C3%A0i%20li%E1%BB%87u-0C0C0C?labelColor=FAFAFA&logo=python&logoColor=0C0C0C" alt="Tài liệu Python"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="Phiên bản PyPI">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="Tài liệu TypeScript">
        <img src="https://img.shields.io/badge/typescript-t%C3%A0i%20li%E1%BB%87u-0C0C0C?labelColor=FAFAFA&logo=typescript&logoColor=0C0C0C" alt="Tài liệu TypeScript"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-node" alt="Phiên bản NPM">
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

Mirage là **hệ thống tệp ảo thống nhất cho AI Agent**: nó gắn các dịch vụ và nguồn dữ liệu như S3, Google Drive, Slack, Gmail và Redis cạnh nhau thành một hệ thống tệp duy nhất. Bất kỳ LLM nào đã biết bash đều có thể đọc, grep và nối pipe trên mọi backend ngay từ đầu, không cần từ vựng mới.

```ts
const ws = new Workspace({
  '/data':  new RAMResource(),
  '/s3':    new S3Resource({ bucket: 'logs' }),
  '/slack': new SlackResource({ token: process.env.SLACK_BOT_TOKEN! }),
})

await ws.execute('grep -r alert /slack/channels/general__C04QX/ | wc -l')
await ws.execute('cp /s3/report.csv /data/local.csv')
await ws.execute('wc -l $(find /s3/data -name "*.jsonl")')

// Lệnh có thể mở rộng: đăng ký lệnh mới, hoặc ghi đè một lệnh theo
// resource + loại tệp, ví dụ `cat` trên tệp Parquet ở S3 trả về các hàng dạng JSON.
ws.command('summarize', ...)
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /data/local.csv')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## Giới thiệu

- **Một giao diện thay vì N SDK và M MCP.** Mọi dịch vụ đều dùng cùng một ngữ nghĩa hệ thống tệp, và pipeline kết hợp giữa các dịch vụ tự nhiên như trên đĩa cục bộ.
- **Khoảng 50 backend tích hợp sẵn:** RAM, Disk, Redis, S3 / R2 / OCI / Supabase / GCS, Gmail / GDrive / GDocs / GSheets / GSlides, GitHub / Linear / Notion / Trello, Slack / Discord / Email, MongoDB / Postgres / LanceDB, SSH và nhiều hơn nữa, được gắn cạnh nhau dưới một gốc duy nhất.
- **Workspace di động:** clone, snapshot và đánh phiên bản workspace; phiên chạy agent di chuyển giữa các máy mà không cần khởi động lại hay cấu hình lại hệ thống.
- **Nhúng được:** SDK Python và TypeScript chạy ngay trong tiến trình của FastAPI, Express, ứng dụng trình duyệt hoặc bất kỳ runtime bất đồng bộ nào; không cần tiến trình riêng.
- **Tích hợp agent:** OpenAI Agents SDK, Vercel AI SDK, LangChain, Pydantic AI, CAMEL và OpenHands qua SDK; các coding agent như Claude Code và Codex qua CLI nhẹ + daemon.

## Kiến trúc

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Kiến trúc Mirage: AI Agent và ứng dụng → Mirage Bash và VFS → Dispatcher và cache → hạ tầng và dịch vụ từ xa" width="720">
  </picture>
</p>

## Cài đặt

- **Python** ≥ 3.11 cho gói `mirage-ai` và CLI `mirage`
- **Node.js** ≥ 20 cho SDK TypeScript
- **macOS** hoặc **Linux** (mount dựa trên FUSE cần nền tảng hỗ trợ)

### Python

```bash
uv add mirage-ai    # cài thư viện `mirage` và binary CLI `mirage`
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # máy chủ Node.js và CLI
npm install @struktoai/mirage-browser   # trình duyệt / edge runtime
npm install @struktoai/mirage-agents    # adapter OpenAI / Vercel AI / LangChain / Mastra
```

Cả hai gói runtime đều tự động kéo theo `@struktoai/mirage-core`.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
# hoặc
npm install -g @struktoai/mirage-cli
# hoặc
uvx mirage-ai
# hoặc
npx @struktoai/mirage-cli
```

## Bắt đầu nhanh

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

## Framework agent

Mirage tích hợp vào các framework agent như một sandbox hoặc lớp công cụ. Các thao tác POSIX như `read` cũng có thể được tùy biến theo resource và loại tệp, ví dụ đọc một tệp PDF trả về các trang đã phân tích thay vì byte thô.

|              | Tích hợp                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python       | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents), [LangChain](https://docs.mirage.strukto.ai/python/agents/langchain), [Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai), [CAMEL](https://docs.mirage.strukto.ai/python/agents/camel), [OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands), [Agno](https://docs.mirage.strukto.ai/python/agents/agno) |
| TypeScript   | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel), [OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai), [LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain), [Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                         |
| Coding agent | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code), [Codex](https://docs.mirage.strukto.ai/python/agents/codex), [OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode), [Pi](https://docs.mirage.strukto.ai/typescript/agents/pi)                                                                                                                                                     |

## Bộ nhớ đệm

Mỗi `Workspace` có bộ nhớ đệm hai tầng, để công việc lặp lại trên các backend từ xa dùng trạng thái cục bộ thay vì mạng:

- **Cache chỉ mục:** danh sách thư mục và metadata. Lần duyệt thư mục đầu tiên gọi API; các lần sau đọc từ chỉ mục cho đến khi TTL hết hạn (mặc định 10 phút).
- **Cache tệp:** byte của đối tượng. Lần đọc đầu tiên stream từ nguồn; các pipeline sau đọc từ cache (mặc định 512 MB).

Cả hai tầng mặc định dùng RAM trong tiến trình, không cần cấu hình. Store Redis chia sẻ trạng thái cache giữa các worker, tiến trình và máy:

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

Xem [tài liệu cache](https://docs.mirage.strukto.ai/home/cache) để biết vòng đời miss/hit đầy đủ.

## Người đóng góp

Cảm ơn tất cả những người đã đóng góp cho Mirage.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Người đóng góp cho Mirage" />
</a>
