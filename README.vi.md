<p align="center">
  <img src="assets/mirage-og-light@2x.png" alt="Mirage: hệ thống tệp ảo thống nhất cho AI Agent" width="900">
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
  <a href="./README.md"><img alt="README tiếng Anh" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="README tiếng Trung giản thể" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.zh-TW.md"><img alt="README tiếng Trung phồn thể" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./README.fr.md"><img alt="README tiếng Pháp" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
</p>

Mirage là **hệ thống tệp ảo thống nhất cho AI Agent**: nó gắn các dịch vụ và nguồn dữ liệu như S3, Google Drive, Slack, Gmail và Redis cạnh nhau trong một cây tệp duy nhất.

AI Agent truy cập mọi backend bằng cùng một nhóm công cụ kiểu Unix, và các pipeline có thể kết hợp qua nhiều dịch vụ tự nhiên như trên đĩa cục bộ. Đây là một môi trường mô phỏng: Agent nhìn thấy một hệ thống tệp duy nhất bên dưới. Bất kỳ LLM nào đã biết bash đều có thể dùng Mirage ngay mà không cần học thêm từ vựng mới.

```ts
const ws = new Workspace({
  '/data': new RAMResource(),
  '/s3': new S3Resource({ bucket: 'logs' }),
  '/slack': new SlackResource({}),
  '/github': new GitHubResource({}),
})

await ws.execute('grep alert /slack/general/*.json | wc -l')
await ws.execute('cat /github/mirage/README.md')
await ws.execute('cp /s3/report.csv /data/local.csv')
// Đăng ký một lệnh mới, dùng được trên mọi mount.
ws.command('summarize', ...)

// Ghi đè một lệnh cho tài nguyên và loại tệp cụ thể.
// `cat` trên tệp Parquet trong /s3 hiển thị các dòng dưới dạng JSON thay vì byte thô.
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /github/mirage/README.md')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## Giới thiệu

- **Một hệ thống tệp cho mọi backend.** Mỗi dịch vụ dùng cùng ngữ nghĩa hệ thống tệp, nên Agent chỉ cần suy luận trên một lớp trừu tượng thay vì N SDK và M MCP; nó dựa vào hệ thống tệp và vốn từ bash mà LLM quen thuộc nhất.
- **Nhiều tài nguyên, một hệ thống tệp:** RAM, Disk, Redis, S3 / R2 / OCI / Supabase / GCS, Gmail / GDrive / GDocs / GSheets / GSlides, GitHub / Linear / Notion / Trello, Slack / Discord / Telegram / Email, MongoDB, SSH và nhiều nguồn khác, được gắn cạnh nhau dưới cùng một root.
- **Công cụ bash quen thuộc trên mọi mount.** Agent tái sử dụng cùng một nhóm công cụ kiểu Unix thay vì học một API mới cho từng dịch vụ, và pipeline kết hợp qua nhiều dịch vụ như trên đĩa cục bộ.
- **Workspace có thể di chuyển:** clone, snapshot và quản lý phiên bản môi trường. Di chuyển lần chạy của Agent giữa các máy mà không cần khởi động lại hoặc cấu hình lại hệ thống.
- **Nhúng vào ứng dụng và dịch vụ của bạn:** SDK Python và TypeScript cho phép đưa hệ thống tệp ảo trực tiếp vào AI Agent trong FastAPI, Express, ứng dụng trình duyệt hoặc bất kỳ runtime bất đồng bộ nào, không cần tiến trình riêng.
- **Hoạt động với các framework Agent phổ biến:** OpenAI Agents SDK, Vercel AI SDK (TypeScript), LangChain, Pydantic AI, CAMEL và OpenHands.
- **CLI + daemon gọn nhẹ:** kết nối với các coding agent như Claude Code và Codex để truy cập mọi tài nguyên đã mount qua bash quen thuộc, giúp mỗi lượt làm được nhiều việc hữu ích hơn.

## Kiến trúc

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mirage-arch-dark.svg">
    <img src="assets/mirage-arch-light.svg" alt="Kiến trúc Mirage: AI Agent và ứng dụng → Mirage Bash và VFS → Dispatcher và Cache → hạ tầng và dịch vụ từ xa" width="900">
  </picture>
</p>

## Cài đặt

### Điều kiện cần

- **Python** ≥ 3.12 cho gói `mirage-ai` và CLI `mirage`
- **Node.js** ≥ 20 cho SDK TypeScript
- **macOS** hoặc **Linux** (mount dựa trên FUSE cần nền tảng hỗ trợ)

### Python

```bash
uv add mirage-ai
```

Lệnh này cài cả thư viện `mirage` và binary CLI `mirage`.

### TypeScript

Chọn gói phù hợp với runtime của bạn:

```bash
npm install @struktoai/mirage-node      # máy chủ Node.js và CLI
npm install @struktoai/mirage-browser   # trình duyệt / runtime edge
npm install @struktoai/mirage-core      # primitive không phụ thuộc runtime
```

`@struktoai/mirage-node` và `@struktoai/mirage-browser` đều tự động kéo `@struktoai/mirage-core`.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
```

Hoặc dùng trình quản lý gói bạn thích:

```bash
npm install -g @struktoai/mirage-cli
```

```bash
uvx mirage-ai
```

```bash
npx @struktoai/mirage-cli
```

## Bắt đầu nhanh (Python)

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

## Bắt đầu nhanh (TypeScript)

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

## Bắt đầu nhanh (CLI)

```bash
mirage workspace create ws.yaml --id demo
mirage execute   --workspace_id demo --command "cp /s3/report.csv /data/report.csv"
mirage provision --workspace_id demo --command "cat /s3/data/large.jsonl"
mirage workspace snapshot demo demo.tar
mirage workspace load demo.tar --id demo-restored
```

## Framework Agent

Mirage tích hợp vào các framework ứng dụng Agent phổ biến như một sandbox hoặc lớp công cụ. Agent làm việc với cùng cây mount như trong bash, nên đổi model hoặc runtime không làm thay đổi giao diện thao tác.

### OpenAI Agents SDK (Python)

`MirageSandboxClient` gắn `Workspace` vào OpenAI Agents SDK như một sandbox: các lệnh bash mà Agent chạy sẽ thực thi trên các mount của bạn.

```python
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig

from mirage.agents.openai_agents import MirageSandboxClient

client = MirageSandboxClient(ws)
agent = SandboxAgent(
    name="Mirage Sandbox Agent",
    model="gpt-5.4-nano",
    instructions=ws.file_prompt,
)

result = await Runner.run(
    agent,
    "Tóm tắt /s3/data/report.parquet vào /report.txt.",
    run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
)
```

### Vercel AI SDK (TypeScript)

`mirageTools(ws)` phơi bày workspace như một bộ công cụ AI SDK có kiểu, để bất kỳ model nào nối với AI SDK cũng có thể đọc và ghi qua các mount, trong Node.js hoặc trình duyệt.

```ts
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { mirageTools } from '@struktoai/mirage-agents/vercel'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'

const { text } = await generateText({
  model: openai('gpt-5.4-nano'),
  system: buildSystemPrompt({ mountInfo: { '/': 'Hệ thống tệp trong bộ nhớ' } }),
  prompt: "Dùng readFile để đọc /docs/paper.pdf, rồi mô tả nội dung trong đó.",
  tools: mirageTools(ws),
})
```

Các adapter LangChain, Pydantic AI, CAMEL, OpenHands và Mastra nằm cùng hệ sinh thái này.

## Bộ nhớ đệm

Mỗi `Workspace` có sẵn **bộ nhớ đệm hai lớp** để các thao tác lặp lại với backend từ xa (S3, GDrive, Slack, v.v.) dùng trạng thái cục bộ thay vì truy cập mạng:

- **Cache chỉ mục.** Danh sách và metadata. Lần duyệt thư mục đầu tiên gọi API; các lần sau dùng chỉ mục cho đến khi TTL hết hạn.
- **Cache tệp.** Byte của object. Lần đọc đầu tiên stream từ nguồn; các pipeline sau đọc từ cache.
- **Backend có thể thay thế.** Mỗi lớp là một store với hai triển khai tích hợp:
  - **RAM** (mặc định): trong tiến trình, không cần cấu hình, cache tệp 512 MB và TTL chỉ mục 10 phút. Phù hợp cho ứng dụng một tiến trình và notebook.
  - **Redis**: chia sẻ giữa worker, tiến trình và máy. Phù hợp cho serverless, dịch vụ nhiều replica hoặc khi bạn muốn trạng thái cache sống qua restart.

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

// 1. Trượt cache chỉ mục → S3 LIST. Danh sách được lưu trong cache chỉ mục.
await ws.execute('ls /s3/data/')

// 2. Trúng cache chỉ mục → 0 lần gọi mạng.
await ws.execute('find /s3/data/ -name "*.jsonl"')

// 3. Trượt cache tệp → S3 GET. Byte được lưu trong cache tệp.
await ws.execute('cat /s3/data/log.jsonl | wc -l')

// 4. Trúng cache tệp → 0 lần gọi mạng.
await ws.execute('grep alert /s3/data/log.jsonl')
```

## Người đóng góp

Cảm ơn tất cả những người đã đóng góp cho Mirage.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Người đóng góp cho Mirage" />
</a>
