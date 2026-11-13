<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage: AI 에이전트를 위한 가상 터미널" width="900">
  </picture>
</p>

<p align="center">
  <a href="https://agentvfs.org">
    <picture>
      <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-narrow-dark.svg">
      <source media="(max-width: 767px)" srcset="../assets/agentvfs-banner-narrow-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-dark.svg">
      <img src="../assets/agentvfs-banner-light.svg" width="900" alt="AgentVFS: AI 에이전트를 위한 개방형, 벤더 중립 가상 파일 시스템 인터페이스" />
    </picture>
  </a>
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="문서">
        <img src="https://img.shields.io/badge/mirage-%EB%AC%B8%EC%84%9C-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="웹사이트">
        <img src="https://img.shields.io/badge/strukto.ai-%EC%A0%9C%EC%9E%91-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="라이선스">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=%EB%9D%BC%EC%9D%B4%EC%84%A0%EC%8A%A4&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://doi.org/10.5281/zenodo.23504502" alt="DOI">
        <img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.23504502-0C0C0C?labelColor=FAFAFA" alt="DOI 10.5281/zenodo.23504502" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord">
        <img src="https://img.shields.io/badge/discord-%EC%B0%B8%EC%97%AC-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <a href="../assets/wechat-qr-code.jpg" aria-label="WeChat 커뮤니티">
        <img src="https://img.shields.io/badge/wechat-%EC%B0%B8%EC%97%AC-0C0C0C?labelColor=FAFAFA&logo=wechat&logoColor=0C0C0C" alt="WeChat 커뮤니티" /></a>
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

Mirage는 **AI 에이전트를 위한 가상 터미널**입니다. 데이터와 CLI, 런타임을 하나로 아우르는 셸입니다. Unix 도구가 모든 서비스에 닿고, `grep`은 Gmail이나 Slack처럼 각 서비스 자체의 검색 위에서 실행됩니다. Mirage는 각 명령을 알맞은 런타임으로 라우팅하므로 대부분의 명령줄은 프로세스 안에서 실행되고 무거운 작업만 샌드박스로 가서 인프라 비용과 토큰을 줄입니다. 터미널 자체도 가볍습니다. 워크스페이스 하나는 메모리를 **약 100 KB**, 새 세션은 **약 10 KB** 차지하므로 하나의 프로세스가 많은 에이전트를 동시에 처리합니다. 프로파일은 에이전트가 무엇을 실행하고 무엇을 볼 수 있는지까지 정하며, 스크립트로 작성하는 정책은 그 규칙으로 표현할 수 없는 것을 거부합니다.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 아키텍처: 에이전트와 하네스가 프로파일과 Mirage 셸에 연결되고, 이들이 유닉스 계열 명령과 가상 CLI, 프로그래밍 언어를 머신과 런타임, 가상 파일 시스템으로 해석하며, 서비스 자격 증명과 정책 엔진, 알림이 함께 있습니다" width="100%">
  </picture>
</p>

다음은 애플리케이션 안에서 Mirage를 실행하는 예입니다:

```python
ws = Workspace(
    {
        "/s3":    (S3VFS(S3Config(bucket="my-bucket")), MountMode.WRITE),
        "/slack": (SlackVFS(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
        "/gmail": (GmailVFS(GmailConfig(**google_credentials)), MountMode.READ),
    },
    # Slack CLI를 설치한다. 다른 프로그램처럼 이름으로 실행되고 `man`과 `which`에 나타난다
    clis={"slack": (SLACK, {"token": slack_bot_token})},
    # analyst 프로파일은 /s3/secrets를 숨기고 Slack 게시와 curl을 금지한다
    profiles={
        "analyst": {
            "paths": {"hide": ["/s3/secrets"]},
            "commands": {"deny": ["slack send-message", "curl"]},
        },
    },
    # python은 워커의 monty에서, 또는 e2b 샌드박스에서 실행된다
    machines={
        "py": {"provider": "worker"},
        "box": {"provider": "e2b", "sandbox_id": sandbox_id, "mount_type": "ssh", "captures": ["python", "python3"]},
    },
    # 연산을 라우팅한다: numpy 줄은 머신에서, 나머지는 monty에서 실행된다
    route_policy=lambda ctx: "box" if "numpy" in ctx.line else None,
)

# analyst 프로파일을 쓰는 에이전트를 추가한다
alice = await ws.session("alice", profile="analyst")

# grep 한 번으로 S3, Slack, Gmail을 훑는다. 자체 검색이 있는 서비스는 그 검색을 쓴다
await alice.shell("grep -rlw invoice /s3 /slack /gmail")

# Slack에 있는 스크립트를 monty에서 실행하고 리포트를 S3에 기록한다
await alice.shell("python3 /slack/channels/general__C0123/2026-10-21/files/report__F0456.py > /s3/report.txt")

# monty에는 numpy가 없으므로 라우팅 정책이 이 줄을 e2b로 보낸다
await alice.shell("python3 -c 'import numpy; print(numpy.arange(10).sum())'")
```

`alice`가 셸에서 보는 화면은 다음과 같습니다:

```console
$ grep -rlw invoice /s3 /slack /gmail
/s3/billing/2026-10.csv
/gmail/INBOX/2026-10-21/Invoice_1042__18f3a9c2b7d1e0f4.gmail.json
$ ls /s3
billing
report.txt
$ cat /s3/secrets/aws.txt
cat: /s3/secrets/aws.txt: No such file or directory
$ slack send-message --channel general --text "report is up"
slack: Permission denied
```

## 소개

- **N개의 SDK와 M개의 MCP 대신 통합된 가상 터미널 인터페이스.** 모든 백엔드가 동일한 파일 시스템 의미론을 사용하므로 파이프라인이 서비스 간에 조합됩니다.
- **모든 소스를 아우르는 가상 파일 시스템.** S3, Google Drive, Slack, Gmail, Redis 등이 하나의 루트 아래 나란히 마운트되어, 에이전트는 이미 아는 unix 도구인 `ls`, `grep`, `find`, `jq`로 통합된 인터페이스를 통해 모두에 접근합니다.
- **가상 명령줄 도구(CLI).** `git`, `slack`, `ntn`은 Mirage가 직접 응답하므로 에이전트는 아무것도 설치하지 않고 서로 다른 런타임과 머신에 걸쳐 서비스를 다룰 수 있고, 하나의 도구를 둘 이상으로 가상화해 각각 고유한 이름과 자격 증명을 줄 수 있습니다.
- **라우팅되는 동적 런타임.** Python, JavaScript를 비롯한 모든 명령을 설정된 런타임으로, 프로세스 내부나 샌드박스 또는 원격으로 보낼 수 있어 연산과 저장소가 분리되고 한쪽을 건드리지 않고 다른 쪽을 바꿀 수 있습니다.
- **가상화된 Mirage 셸.** 파일 시스템과 CLI, 런타임을 하나의 명령줄로 묶어 파이프, 리다이렉션, 변수, 잡, 히스토리가 셋 모두에서 동작합니다.
- **가벼운 설계.** 가상 터미널 그 자체인 워크스페이스는 메모리를 약 100 KB, 새 세션은 약 10 KB 차지하므로, 에이전트마다 컨테이너나 VM 없이 하나의 프로세스가 많은 에이전트를 처리합니다.
- **에이전트를 위해 설계된 프로파일.** `allow`, `ask`, `deny`가 명령과 CLI를 통제하고 `hide`와 `show`가 파일과 폴더를 통제하므로, 숨겨진 경로는 단순히 읽을 수 없는 것이 아니라 에이전트가 보는 파일 시스템에 존재하지 않습니다.
- **스크립트로 작성하는 정책 엔진.** 정책 스크립트는 위험한 동작을 실행 전에 금지할 수 있으며, 같은 스택이 모든 VFS 작업과 세션 쓰기를 통제하므로 파일도 환경 변수도 새어 나가지 않습니다.
- **VFS와 에이전트에 연결된 알림.** 외부 변경이 마운트의 이벤트 스트림이 되므로 새로운 Slack 답장은 가상 파일 시스템의 대화 파일 변경으로 나타나고, 에이전트는 트리를 다시 훑는 대신 그에 반응합니다.

## 가상 파일 시스템

[Mirage](https://www.strukto.ai/mirage)는 모든 것을 AI 에이전트를 위한 하나의 통합 가상 파일 시스템으로 "마운트"합니다. 각 서비스는 하나의 루트 아래 나란히 놓이고 같은 POSIX 의미론을 따릅니다.

|                                  | VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **오브젝트 스토리지**            | <a href="https://aws.amazon.com/s3/"><img src="https://api.iconify.design/logos/aws-s3.svg" width="20" height="20" alt="Amazon S3" title="Amazon S3" /></a>  <a href="https://developers.cloudflare.com/r2/"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare R2" title="Cloudflare R2" /></a>  <a href="https://cloud.google.com/storage"><img src="https://api.iconify.design/logos/google-cloud.svg" width="25" height="20" alt="Google Cloud Storage" title="Google Cloud Storage" /></a>  <a href="https://www.oracle.com/cloud/storage/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/oracle.svg" width="32" height="20" alt="Oracle OCI" title="Oracle OCI" /></a>  <a href="https://supabase.com/storage"><img src="https://api.iconify.design/logos/supabase-icon.svg" width="19" height="20" alt="Supabase Storage" title="Supabase Storage" /></a>  <a href="https://min.io"><img src="https://cdn.simpleicons.org/minio" width="20" height="20" alt="MinIO" title="MinIO" /></a>  <a href="https://ceph.io/en/discover/technology/"><img src="https://cdn.simpleicons.org/ceph" width="20" height="20" alt="Ceph" title="Ceph" /></a>  <a href="https://github.com/seaweedfs/seaweedfs"><img src="../assets/icons/seaweedfs.svg" width="20" height="20" alt="SeaweedFS" title="SeaweedFS" /></a>  <a href="https://wasabi.com/cloud-object-storage"><img src="https://cdn.simpleicons.org/wasabi" width="20" height="20" alt="Wasabi" title="Wasabi" /></a>  <a href="https://www.backblaze.com/cloud-storage"><img src="https://cdn.simpleicons.org/backblaze" width="20" height="20" alt="Backblaze B2" title="Backblaze B2" /></a>  <a href="https://www.digitalocean.com/products/spaces"><img src="https://cdn.simpleicons.org/digitalocean" width="20" height="20" alt="DigitalOcean Spaces" title="DigitalOcean Spaces" /></a>  <a href="https://www.alibabacloud.com/product/oss"><img src="https://cdn.simpleicons.org/alibabacloud" width="20" height="20" alt="Alibaba Cloud OSS" title="Alibaba Cloud OSS" /></a>  <a href="https://www.tencentcloud.com/products/cos"><img src="../assets/icons/tencent.png" width="20" height="20" alt="Tencent Cloud COS" title="Tencent Cloud COS" /></a>  <a href="https://www.scaleway.com/en/object-storage/"><img src="https://cdn.simpleicons.org/scaleway" width="20" height="20" alt="Scaleway" title="Scaleway" /></a>  <a href="https://www.qingcloud.com/products/qingstor"><img src="../assets/icons/qingstor.png" width="20" height="20" alt="QingStor" title="QingStor" /></a>  <a href="https://huggingface.co/docs/hub/storage-buckets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Buckets" title="Hugging Face Buckets" /></a>  <a href="https://www.mongodb.com/docs/manual/core/gridfs/"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="GridFS" title="GridFS" /></a> |
| **파일과 문서**                  | <a href="https://workspace.google.com/products/drive/"><img src="https://cdn.simpleicons.org/googledrive" width="20" height="20" alt="Google Drive" title="Google Drive" /></a>  <a href="https://docs.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-docs.svg" width="14" height="20" alt="Google Docs" title="Google Docs" /></a>  <a href="https://sheets.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-sheets.svg" width="15" height="20" alt="Google Sheets" title="Google Sheets" /></a>  <a href="https://slides.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-slides.svg" width="15" height="20" alt="Google Slides" title="Google Slides" /></a>  <a href="https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-onedrive.svg" width="30" height="20" alt="OneDrive" title="OneDrive" /></a>  <a href="https://www.microsoft.com/microsoft-365/sharepoint/collaboration"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-sharepoint.svg" width="20" height="20" alt="SharePoint" title="SharePoint" /></a>  <a href="https://www.box.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/box.svg" width="20" height="20" alt="Box" title="Box" /></a>  <a href="https://www.dropbox.com"><img src="https://cdn.simpleicons.org/dropbox" width="20" height="20" alt="Dropbox" title="Dropbox" /></a>  <a href="https://nextcloud.com/files/"><img src="https://cdn.simpleicons.org/nextcloud" width="20" height="20" alt="Nextcloud" title="Nextcloud" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **메시징과 업무**                | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="Slack" title="Slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="Discord" title="Discord" /></a>  <a href="https://mail.google.com"><img src="https://cdn.simpleicons.org/gmail" width="20" height="20" alt="Gmail" title="Gmail" /></a>  <a href="https://en.wikipedia.org/wiki/Internet_Message_Access_Protocol"><img src="https://api.iconify.design/lucide/mail.svg?color=%23888888" width="20" height="20" alt="IMAP / SMTP email" title="IMAP / SMTP email" /></a>  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="GitHub" title="GitHub" /></a>  <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="Linear" title="Linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="Notion" title="Notion" /></a>  <a href="https://trello.com"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="Trello" title="Trello" /></a>  <a href="https://workspace.google.com/products/calendar/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-calendar.svg" width="20" height="20" alt="Google Calendar" title="Google Calendar" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **데이터베이스와 데이터 플랫폼** | <a href="https://www.postgresql.org"><img src="https://cdn.simpleicons.org/postgresql" width="20" height="20" alt="PostgreSQL" title="PostgreSQL" /></a>  <a href="https://www.mongodb.com"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="MongoDB" title="MongoDB" /></a>  <a href="https://redis.io"><img src="https://cdn.simpleicons.org/redis" width="20" height="20" alt="Redis" title="Redis" /></a> <a href="https://upstash.com"><img src="https://cdn.simpleicons.org/upstash" width="20" height="20" alt="Upstash Redis" title="Upstash Redis" /></a>  <a href="https://lancedb.com"><img src="../assets/icons/lancedb.png" width="20" height="20" alt="LanceDB" title="LanceDB" /></a>  <a href="https://qdrant.tech"><img src="https://cdn.simpleicons.org/qdrant" width="20" height="20" alt="Qdrant" title="Qdrant" /></a>  <a href="https://www.trychroma.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/chroma.svg" width="31" height="20" alt="Chroma" title="Chroma" /></a>  <a href="https://mem0.ai"><img src="../docs/images/mem0.svg" width="20" height="20" alt="Mem0" title="Mem0" /></a>  <a href="https://huggingface.co/datasets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Datasets" title="Hugging Face Datasets" /></a>  <a href="https://huggingface.co/models"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Models" title="Hugging Face Models" /></a>  <a href="https://huggingface.co/spaces"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Spaces" title="Hugging Face Spaces" /></a>  <a href="https://docs.databricks.com/aws/en/volumes/"><img src="https://cdn.simpleicons.org/databricks" width="20" height="20" alt="Databricks Volumes" title="Databricks Volumes" /></a>  <a href="https://dify.ai"><img src="https://cdn.simpleicons.org/dify" width="20" height="20" alt="Dify" title="Dify" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **관측성**                       | <a href="https://langfuse.com"><img src="../docs/images/langfuse-logo.svg" width="20" height="20" alt="Langfuse" title="Langfuse" /></a>  <a href="https://www.jaegertracing.io"><img src="https://cdn.simpleicons.org/jaeger" width="20" height="20" alt="Jaeger" title="Jaeger" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **로컬과 원격**                  | <a href="https://en.wikipedia.org/wiki/Random-access_memory"><img src="https://api.iconify.design/lucide/memory-stick.svg?color=%23888888" width="20" height="20" alt="RAM" title="RAM" /></a>  <a href="https://en.wikipedia.org/wiki/File_system"><img src="https://api.iconify.design/lucide/hard-drive.svg?color=%23888888" width="20" height="20" alt="Disk" title="Disk" /></a>  <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system"><img src="https://api.iconify.design/lucide/folder-lock.svg?color=%23888888" width="20" height="20" alt="OPFS" title="OPFS" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

에이전트는 Python과 TypeScript SDK, `mirage` CLI, 또는 FUSE와 FSKit을 통한 실제 마운트 지점으로 접근한 뒤, `ls`, `grep`, `find`, `jq`처럼 이미 아는 unix 도구로 다룹니다.

## 가상 명령줄 도구

이 명령줄 도구들은 가상화되어 있습니다. [Mirage](https://www.strukto.ai/mirage)가 `git`, `slack`, `ntn`에 직접 응답하므로, 에이전트는 머신에 해당 프로그램이 설치되지 않아도 서비스를 다룹니다. 각 도구는 실제 도구를 그대로 흉내 내므로 그 CLI를 아는 에이전트는 새로 배울 것이 없습니다. 가상이기 때문에 같은 도구를 서로 다른 이름으로 여러 번 설치하고 각각에 고유한 자격 증명을 줄 수 있어, 모든 에이전트가 정확히 주어진 계정만 갖습니다.

|                   | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **코드**          | <a href="https://git-scm.com"><img src="https://cdn.simpleicons.org/git" width="20" height="20" alt="git" title="git" /></a>  <a href="https://cli.github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="gh" title="gh" /></a>                                                                                                                                                                                                                                                                                           |
| **커뮤니케이션**  | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="slack" title="slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="discord" title="discord" /></a>  <a href="https://github.com/pimalaya/himalaya"><img src="../assets/icons/himalaya.png" width="20" height="20" alt="himalaya" title="himalaya" /></a>                                                                                                                         |
| **업무와 데이터** | <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="linear" title="linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="ntn" title="ntn" /></a>  <a href="https://workspace.google.com"><img src="https://cdn.simpleicons.org/google" width="20" height="20" alt="gws" title="gws" /></a>  <a href="https://huggingface.co"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="hf" title="hf" /></a> |

## 가상 런타임

런타임도 같은 방식으로 가상화되며, 프로그래밍 언어에만 해당하지 않습니다. 명령줄의 어떤 명령이든 설정된 런타임으로 보낼 수 있어서, Python은 [Monty](https://pydantic.dev/articles/pydantic-monty)로 프로세스 안에서 실행하고 다른 명령, 예를 들어 `kubectl`은 SSH로 원격 머신에 보낼 수 있습니다. 어떤 줄을 어떤 런타임이 처리할지는 [스크립트 런타임 라우터](https://docs.mirage.strukto.ai/home/policy/route-runtime)가 결정할 수 있습니다.

|                | 런타임                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**     | <a href="https://pydantic.dev/articles/pydantic-monty"><img src="https://cdn.simpleicons.org/pydantic" width="20" height="20" alt="Monty" title="Monty" /></a>  <a href="https://wasi.dev"><img src="https://cdn.simpleicons.org/webassembly" width="20" height="20" alt="WASI CPython on wasmtime" title="WASI CPython on wasmtime" /></a>  <a href="https://pyodide.org"><img src="../assets/icons/pyodide.svg" width="56" height="20" alt="Pyodide" title="Pyodide" /></a>  <a href="https://pypi.org/project/sandlock/"><img src="../docs/images/sandlock-logo.svg" width="20" height="20" alt="sandlock" title="sandlock" /></a>  <a href="https://www.python.org"><img src="https://cdn.simpleicons.org/python" width="20" height="20" alt="Host CPython" title="Host CPython" /></a>                                                                                                                                                                                                                                                   |
| **JavaScript** | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="../assets/icons/quickjs.png" width="20" height="20" alt="QuickJS, serving node and js" title="QuickJS, serving node and js" /></a> <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><img src="https://cdn.simpleicons.org/javascript" width="20" height="20" alt="JavaScript" title="JavaScript" /></a> <a href="https://www.typescriptlang.org"><img src="https://cdn.simpleicons.org/typescript" width="20" height="20" alt="TypeScript" title="TypeScript" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **머신**       | <a href="https://www.docker.com"><img src="https://cdn.simpleicons.org/docker" width="20" height="20" alt="Docker" title="Docker" /></a>  <a href="https://e2b.dev"><img src="../docs/images/e2b-logo.svg" width="20" height="20" alt="E2B" title="E2B" /></a>  <a href="https://www.daytona.io"><img src="../docs/images/daytona-logo.svg" width="20" height="20" alt="Daytona" title="Daytona" /></a>  <a href="https://smolmachines.com"><img src="../docs/images/smolvm-logo.svg" width="20" height="20" alt="smolVM" title="smolVM" /></a> <a href="https://microsandbox.dev"><img src="../docs/images/microsandbox-logo.svg" width="20" height="20" alt="Microsandbox" title="Microsandbox" /></a> <a href="https://github.com/apple/container"><img src="https://cdn.simpleicons.org/apple/000000/e6edf3" width="20" height="20" alt="Apple Container" title="Apple Container" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a> |

## 보안

프로파일은 세션이 무엇을 실행하고 무엇을 볼 수 있는지 정합니다. 명령은 사용자 정의 가능한 `allow`, `ask`, `deny` 규칙으로, 경로는 `hide`와 `show`로 통제하므로, 숨겨진 파일은 단순히 읽을 수 없는 것이 아니라 에이전트가 보는 파일 시스템에 존재하지 않습니다. 이 규칙으로 표현할 수 없는 경우에는 프로파일이 정책 스크립트를 지정할 수 있습니다. 이 스크립트는 모든 명령의 관문에서 실행되어 allow, deny, ask를 직접 답하지만, 다른 모든 규칙처럼 제한만 할 수 있고 권한을 부여하지는 못합니다. 이와 별도로 호스트는 [정책 엔진](https://docs.mirage.strukto.ai/home/policy/policies)에 자체 정책을 등록할 수 있습니다. 정책 엔진은 워크스페이스가 모든 명령, VFS 작업, 세션 쓰기마다 참조하는 순서 있는 스택입니다. [정책 문서](https://docs.mirage.strukto.ai/home/policy/overview)를 참고하세요.

## 서비스 자격 증명

서비스 자격 증명은 비밀이 이미 저장된 곳, 즉 AWS Secrets Manager, 1Password, dotenv와 연동되므로, Mirage의 환경 변수가 그중 한 곳에 있는 자격 증명으로 바로 해석될 수 있습니다.

|                 | 소스                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **내장**        | <a href="https://en.wikipedia.org/wiki/Environment_variable"><img src="../assets/icons/terminal.svg" width="20" height="20" alt="Environment" title="Environment" /></a> <a href="https://www.dotenv.org"><img src="https://cdn.simpleicons.org/dotenv" width="20" height="20" alt="dotenv" title="dotenv" /></a>                                          |
| **사용자 정의** | <a href="https://1password.com"><img src="https://cdn.simpleicons.org/1password" width="20" height="20" alt="1Password" title="1Password" /></a> <a href="https://aws.amazon.com/secrets-manager/"><img src="https://api.iconify.design/logos/aws-secrets-manager.svg" width="20" height="20" alt="AWS Secrets Manager" title="AWS Secrets Manager" /></a> |

## 설치

- **Python** ≥ 3.12: `mirage-ai` 패키지와 `mirage` CLI
- **Node.js** Node 22는 22.20+, Node 24는 24.12+, 또는 25+: TypeScript SDK

### Python

```bash
uv add mirage-ai              # `mirage` 라이브러리와 `mirage` CLI 바이너리를 설치
uv add 'mirage-ai[openai]'    # OpenAI Agents 어댑터, 에이전트 프레임워크마다 별도 extra
uv add 'mirage-ai[monty]'     # Monty, 예제가 쓰는 프로세스 내 Python 런타임
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js 서버와 CLI
npm install @struktoai/mirage-browser   # 브라우저 / edge 런타임
npm install @struktoai/mirage-vercel    # Vercel AI 어댑터, 에이전트 프레임워크마다 별도 패키지
```

두 런타임 패키지 모두 `@struktoai/mirage-core`를 자동으로 가져옵니다.

### CLI

```bash
npm install -g @struktoai/mirage-cli
# 또는
uvx --from mirage-ai mirage
# 또는
npx @struktoai/mirage-cli
```

시작하려면 [Python](https://docs.mirage.strukto.ai/python/quickstart), [TypeScript](https://docs.mirage.strukto.ai/typescript/quickstart), [CLI](https://docs.mirage.strukto.ai/home/access/cli) 빠른 시작 가이드를 참고하세요.

## 스크립트 정책

프로파일은 규칙으로 표현할 수 없는 것을 위해 정책 스크립트를 지정할 수 있습니다. 스크립트의 `pre_command`는 명령을 받아 그 명령이 가리키는 파일을 열어 볼 수 있고, deny나 ask 또는 `None`을 반환합니다. 다음 스크립트는 `rm`과, 코드가 파일을 삭제하는 Python 스크립트를 막습니다:

```python
def deletes(path):
    try:
        code = open(path).read()
    except OSError:
        return False
    return any(call in code for call in ("os.remove", "os.unlink", "shutil.rmtree"))


def pre_command(ctx):
    if ctx["command"] == "rm" or (
        ctx["command"].startswith("python") and any(deletes(p) for p in ctx["paths"])
    ):
        return {"kind": "deny", "reason": "deleting files is disabled"}
```

프로파일에 등록합니다. 여기서는 모든 명령 전에 Monty에서 실행되도록 합니다:

```python
ws = Workspace(
    {"/s3": (S3VFS(S3Config(bucket="my-bucket")), MountMode.WRITE)},
    profiles={
        "analyst": {
            "policy": {
                "pre_command": [{"script": ScriptSource(Path("guard.py").read_text()), "runtime": "monty"}],
            },
        },
    },
    profile="analyst",
)
```

```console
$ cat /s3/clean.py
import os
os.remove("/s3/report.txt")
$ rm /s3/report.txt
rm: Permission denied
$ python3 /s3/clean.py
python3: Permission denied
```

스크립트가 응답할 수 있는 다른 단계는 [정책 스크립트](https://docs.mirage.strukto.ai/home/policy/scripts)를 참고하세요.

## 임베디드 터미널

대부분의 경우 에이전트에게 필요한 것은 샌드박스가 아니라 터미널 같은 인터페이스뿐이며, Mirage는 이를 애플리케이션 서버에 내장합니다. 각 터미널은 고유한 작업 디렉터리, 환경, 히스토리를 가진 Mirage 세션이고 Python은 Monty로 프로세스 안에서 실행되므로, 컨테이너나 VM 없이 터미널이 시작됩니다. 다음은 Express 예시이며, FastAPI 버전은 [문서](https://docs.mirage.strukto.ai/home/examples/lightweight-terminal)에 있습니다.

```bash
npm install @struktoai/mirage-node @pydantic/monty express
```

```ts
import express from 'express'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

const ws = new Workspace(
  { '/work': new RAMVFS() },
  { mode: MountMode.EXEC, machines: { py: { provider: 'worker' } } },
)
const app = express()
app.use(express.json())

app.post('/sessions/:id', (req, res) => {
  ws.createSession(req.params.id)
  res.sendStatus(201)
})

app.post('/sessions/:id/run', async (req, res) => {
  const r = await ws.shell(req.body.command, { sessionId: req.params.id })
  res.json({ stdout: r.stdoutText, stderr: r.stderrText, exitCode: r.exitCode })
})

app.listen(3000, '127.0.0.1')
```

## 기여자

Mirage에 기여해 주신 모든 분께 감사드립니다.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 기여자" />
</a>
