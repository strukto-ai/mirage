<p align="center">
  <img src="../assets/mirage-og-light@2x.png" alt="Mirage: AI 에이전트를 위한 통합 가상 파일 시스템" width="900">
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="문서">
        <img src="https://img.shields.io/badge/mirage-%EB%AC%B8%EC%84%9C-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="웹사이트">
        <img src="https://img.shields.io/badge/strukto.ai-%EC%A0%9C%EC%9E%91-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="라이선스">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=%EB%9D%BC%EC%9D%B4%EC%84%A0%EC%8A%A4&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord">
        <img src="https://img.shields.io/badge/discord-%EC%B0%B8%EC%97%AC-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Python 문서">
        <img src="https://img.shields.io/badge/python-%EB%AC%B8%EC%84%9C-0C0C0C?labelColor=FAFAFA&logo=python&logoColor=0C0C0C" alt="Python 문서"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="PyPI 버전">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="TypeScript 문서">
        <img src="https://img.shields.io/badge/typescript-%EB%AC%B8%EC%84%9C-0C0C0C?labelColor=FAFAFA&logo=typescript&logoColor=0C0C0C" alt="TypeScript 문서"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-node" alt="NPM 버전">
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

Mirage는 **AI 에이전트를 위한 통합 가상 파일 시스템**입니다. S3, Google Drive, Slack, Gmail, Redis 같은 서비스와 데이터 소스를 나란히 하나의 파일 시스템으로 마운트합니다. bash를 이미 아는 LLM이라면 새로운 어휘 없이 바로 모든 백엔드를 읽고, grep하고, 파이프로 연결할 수 있습니다.

```ts
const ws = new Workspace({
  '/data':  new RAMResource(),
  '/s3':    new S3Resource({ bucket: 'logs' }),
  '/slack': new SlackResource({ token: process.env.SLACK_BOT_TOKEN! }),
})

await ws.execute('grep -r alert /slack/channels/general__C04QX/ | wc -l')
await ws.execute('cp /s3/report.csv /data/local.csv')
await ws.execute('wc -l $(find /s3/data -name "*.jsonl")')

// 명령은 확장 가능합니다. 새 명령을 등록하거나 리소스 + 파일 타입별로
// 명령을 재정의할 수 있습니다. 예: S3의 Parquet 파일에 `cat`을 실행하면
// 행을 JSON으로 렌더링합니다.
ws.command('summarize', ...)
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /data/local.csv')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## 소개

- **N개의 SDK와 M개의 MCP 대신 하나의 인터페이스.** 모든 서비스가 동일한 파일 시스템 의미론을 사용하며, 파이프라인은 로컬 디스크에서처럼 자연스럽게 서비스 간에 조합됩니다.
- **약 50개의 내장 백엔드:** RAM, Disk, Redis, S3 / R2 / OCI / Supabase / GCS, Gmail / GDrive / GDocs / GSheets / GSlides, GitHub / Linear / Notion / Trello, Slack / Discord / Email, MongoDB / Postgres / LanceDB, SSH 등을 하나의 루트 아래 나란히 마운트합니다.
- **이식 가능한 워크스페이스:** 워크스페이스를 클론, 스냅샷, 버전 관리할 수 있습니다. 에이전트 실행을 재시작이나 재설정 없이 머신 간에 옮길 수 있습니다.
- **임베딩 가능:** Python과 TypeScript SDK가 FastAPI, Express, 브라우저 앱 또는 모든 비동기 런타임의 프로세스 안에서 직접 실행됩니다. 별도 프로세스가 필요 없습니다.
- **에이전트 통합:** OpenAI Agents SDK, Vercel AI SDK, LangChain, Pydantic AI, CAMEL, OpenHands는 SDK로, Claude Code와 Codex 같은 코딩 에이전트는 경량 CLI + 데몬으로 지원합니다.

## 아키텍처

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 아키텍처: AI 에이전트와 애플리케이션 → Mirage Bash와 VFS → Dispatcher와 캐시 → 인프라와 원격 서비스" width="720">
  </picture>
</p>

## 설치

- **Python** ≥ 3.11: `mirage-ai` 패키지와 `mirage` CLI
- **Node.js** ≥ 20: TypeScript SDK
- **macOS** 또는 **Linux** (FUSE 기반 마운트는 플랫폼 지원 필요)

### Python

```bash
uv add mirage-ai    # `mirage` 라이브러리와 `mirage` CLI 바이너리를 설치
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js 서버와 CLI
npm install @struktoai/mirage-browser   # 브라우저 / edge 런타임
npm install @struktoai/mirage-agents    # OpenAI / Vercel AI / LangChain / Mastra 어댑터
```

두 런타임 패키지 모두 `@struktoai/mirage-core`를 자동으로 가져옵니다.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
# 또는
npm install -g @struktoai/mirage-cli
# 또는
uvx mirage-ai
# 또는
npx @struktoai/mirage-cli
```

## 빠른 시작

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

## 에이전트 프레임워크

Mirage는 샌드박스 또는 도구 레이어로 에이전트 프레임워크에 연결됩니다. `read` 같은 POSIX 연산도 리소스와 파일 타입별로 커스터마이즈할 수 있습니다. 예를 들어 PDF를 읽으면 원시 바이트 대신 파싱된 페이지를 돌려받습니다.

|               | 통합                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python        | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents), [LangChain](https://docs.mirage.strukto.ai/python/agents/langchain), [Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai), [CAMEL](https://docs.mirage.strukto.ai/python/agents/camel), [OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands), [Agno](https://docs.mirage.strukto.ai/python/agents/agno) |
| TypeScript    | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel), [OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai), [LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain), [Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                         |
| 코딩 에이전트 | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code), [Codex](https://docs.mirage.strukto.ai/python/agents/codex), [OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode), [Pi](https://docs.mirage.strukto.ai/typescript/agents/pi)                                                                                                                                                     |

## 캐시

모든 `Workspace`에는 2계층 캐시가 있어, 원격 백엔드에 대한 반복 작업이 네트워크 대신 로컬 상태를 사용합니다:

- **인덱스 캐시:** 디렉터리 목록과 메타데이터. 첫 디렉터리 탐색은 API를 호출하고, 이후에는 TTL이 만료될 때까지(기본 10분) 인덱스에서 제공합니다.
- **파일 캐시:** 객체 바이트. 첫 읽기는 원본에서 스트리밍하고, 이후 파이프라인은 캐시에서 읽습니다(기본 512 MB).

두 계층 모두 기본값은 설정이 필요 없는 프로세스 내 RAM입니다. Redis 스토어를 쓰면 워커, 프로세스, 머신 간에 캐시 상태를 공유합니다:

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

전체 miss/hit 라이프사이클은 [캐시 문서](https://docs.mirage.strukto.ai/home/cache)를 참고하세요.

## 기여자

Mirage에 기여해 주신 모든 분께 감사드립니다.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 기여자" />
</a>
