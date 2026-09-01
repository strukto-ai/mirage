<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage: AI 에이전트를 위한 가상 터미널" width="900">
  </picture>
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
  <a href="./README.de.md"><img alt="README auf Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="./README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage는 **AI 에이전트를 위한 가상 터미널**입니다. 가상 파일 시스템은 폭넓은 데이터 컨텍스트를 제공하고, 가상화된 CLI는 에이전트에게 더 유연한 도구 사용을 주며, 동적 런타임은 기반 인프라 비용을 줄이고 토큰을 더 아낍니다. 에이전트의 동작은 물론 무엇을 볼 수 있는지까지 세밀하게 제어하여 최고의 보안을 제공합니다. 이 요소들이 함께 하나의 가상화된 터미널을 이루어 최고의 에이전트 성능과 비용 효율, 보안을 제공합니다.

```python
ws = Workspace(
    {
        "/tmp":   (RAMResource(), MountMode.EXEC),
        "/redis": (RedisResource(url=redis_url), MountMode.WRITE),
        "/slack": (SlackResource(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
    },
    # monty가 python을 가로채므로 스크립트는 워크스페이스 안에서 샌드박스로 실행된다
    runtimes=[MontyRuntime(captures=["python", "python3"]), "vfs"],
)

# grep 한 번으로 모든 소스를 훑는다
await ws.execute("grep -rln session /redis /tmp")

# Slack에 있는 스크립트를 실행하고 리포트를 Redis에 기록한다
await ws.execute("python3 /slack/channels/general_.../files/example__F....py > /redis/report.txt")

# 헤드 워드로 타입이 있는 CLI를 설치한다: 경로가 아니라 이름으로 디스패치되고,
# 다른 프로그램처럼 `man`, `type`, `which`로 찾을 수 있다
ws.register_cli("slack", SLACK, {"token": slack_bot_token})
await ws.execute('slack send-message --channel general --text "report is up"')
```

## 소개

- **N개의 SDK와 M개의 MCP 대신 통합된 가상 터미널 인터페이스.** 모든 백엔드가 동일한 파일 시스템 의미론을 사용하므로 파이프라인이 서비스 간에 조합됩니다.
- **모든 소스를 아우르는 가상 파일 시스템.** S3, Google Drive, Slack, Gmail, Redis 등이 하나의 루트 아래 나란히 마운트되어, 에이전트는 이미 아는 unix 도구인 `ls`, `grep`, `find`, `jq`로 통합된 인터페이스를 통해 모두에 접근합니다.
- **가상 명령줄 도구(CLI).** `git`, `slack`, `ntn`은 Mirage가 직접 응답하므로 에이전트는 아무것도 설치하지 않고 서로 다른 런타임과 머신에 걸쳐 서비스를 다룰 수 있고, 하나의 도구를 둘 이상으로 가상화해 각각 고유한 이름과 자격 증명을 줄 수 있습니다.
- **라우팅되는 동적 런타임.** Python, JavaScript를 비롯한 모든 명령을 설정된 런타임으로, 프로세스 내부나 샌드박스 또는 원격으로 보낼 수 있어 연산과 저장소가 분리되고 한쪽을 건드리지 않고 다른 쪽을 바꿀 수 있습니다.
- **가상화된 Mirage 셸.** 파일 시스템과 CLI, 런타임을 하나의 명령줄로 묶어 파이프, 리다이렉션, 변수, 잡, 히스토리가 셋 모두에서 동작합니다.
- **에이전트를 위해 설계된 프로파일.** `allow`, `ask`, `deny`가 명령과 CLI를 통제하고 `hide`와 `show`가 파일과 폴더를 통제하므로, 숨겨진 경로는 단순히 읽을 수 없는 것이 아니라 에이전트가 보는 파일 시스템에 존재하지 않습니다.
- **스크립트로 작성하는 정책 엔진.** 정책 스크립트는 위험한 동작을 실행 전에 금지할 수 있으며, 같은 스택이 모든 VFS 작업과 세션 쓰기를 통제하므로 파일도 환경 변수도 새어 나가지 않습니다.
- **VFS와 에이전트에 연결된 알림.** 외부 변경이 마운트의 이벤트 스트림이 되므로 새로운 Slack 답장은 가상 파일 시스템의 대화 파일 변경으로 나타나고, 에이전트는 트리를 다시 훑는 대신 그에 반응합니다.

## 아키텍처

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 아키텍처: 에이전트와 하네스가 프로파일과 Mirage 셸에 연결되고, 이들이 유닉스 계열 명령과 가상 CLI, 프로그래밍 언어를 런타임과 가상 파일 시스템으로 해석하며, 인증과 정책 엔진, 알림이 함께 있습니다" width="100%">
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

Mirage는 샌드박스 또는 도구 계층으로 에이전트 프레임워크에 연결된다. `read` 같은 POSIX 연산도 리소스와 파일 타입별로 커스터마이즈할 수 있다: Mirage는 파일 타입 렌더러를 전혀 포함하지 않으므로 형식은 등록한 방식대로 렌더링되며, 특정 리소스와 확장자에 등록한 명령이 일반 명령보다 우선한다.

|               | 통합                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python        | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents), [LangChain](https://docs.mirage.strukto.ai/python/agents/langchain), [Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai), [CAMEL](https://docs.mirage.strukto.ai/python/agents/camel), [OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands), [Agno](https://docs.mirage.strukto.ai/python/agents/agno)      |
| TypeScript    | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel), [OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai), [LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain), [Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                              |
| 코딩 에이전트 | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code), [Codex](https://docs.mirage.strukto.ai/typescript/agents/codex), [DeepSeek Harness](https://docs.mirage.strukto.ai/typescript/agents/dsh), [Grok Build](https://docs.mirage.strukto.ai/typescript/agents/grok-build), [OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode), [Pi](https://docs.mirage.strukto.ai/typescript/agents/pi) |

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
