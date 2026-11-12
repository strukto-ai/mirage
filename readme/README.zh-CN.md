<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的虚拟终端" width="900">
  </picture>
</p>

<p align="center">
  <a href="https://agentvfs.org">
    <picture>
      <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-narrow-dark.svg">
      <source media="(max-width: 767px)" srcset="../assets/agentvfs-banner-narrow-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-dark.svg">
      <img src="../assets/agentvfs-banner-light.svg" width="900" alt="AgentVFS：开放、厂商中立的 AI Agent 虚拟文件系统接口" />
    </picture>
  </a>
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="文档">
        <img src="https://img.shields.io/badge/mirage-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="官网">
        <img src="https://img.shields.io/badge/strukto.ai-%E5%87%BA%E5%93%81-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="许可证">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://doi.org/10.5281/zenodo.23504502" alt="DOI">
        <img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.23504502-0C0C0C?labelColor=FAFAFA" alt="DOI 10.5281/zenodo.23504502" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord 社区">
        <img src="https://img.shields.io/badge/discord-%E5%8A%A0%E5%85%A5-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <a href="../assets/wechat-qr-code.jpg" aria-label="微信社区">
        <img src="https://img.shields.io/badge/wechat-%E5%8A%A0%E5%85%A5-0C0C0C?labelColor=FAFAFA&logo=wechat&logoColor=0C0C0C" alt="微信社区" /></a>
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

Mirage 是 **面向 AI Agent 的虚拟终端**：一个覆盖数据、CLI 和运行时的 Shell。Unix 工具可以触达每个服务，`grep` 会使用各服务自身的搜索，例如 Gmail 或 Slack 的搜索。Mirage 把每条命令路由到适合它的运行时，因此大多数命令行在进程内运行，只有繁重的工作才会进入沙箱，从而降低基础设施成本并节省 token。终端本身很轻：一个工作区约占 **100 KB** 内存，每个新会话约 **10 KB**，因此一个进程可以同时服务许多 Agent。Profile 决定 Agent 能运行什么，甚至能看到什么，而可脚本化的策略会拒绝这些规则无法表达的任何操作。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 架构：Agent 与 Harness 连接 Profile 和 Mirage Shell，二者把类 Unix 命令、虚拟 CLI 和编程语言解析到机器、运行时与虚拟文件系统上，服务凭据、策略引擎和通知在旁" width="100%">
  </picture>
</p>

下面是在应用中启动 Mirage 的示例：

```python
ws = Workspace(
    {
        "/s3":    (S3VFS(S3Config(bucket="my-bucket")), MountMode.WRITE),
        "/slack": (SlackVFS(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
        "/gmail": (GmailVFS(GmailConfig(**google_credentials)), MountMode.READ),
    },
    # 安装 Slack CLI，按名称运行，并像其他程序一样出现在 `man` 和 `which` 中
    clis={"slack": (SLACK, {"token": slack_bot_token})},
    # analyst Profile 隐藏 /s3/secrets，并禁止向 Slack 发帖和使用 curl
    profiles={
        "analyst": {
            "paths": {"hide": ["/s3/secrets"]},
            "commands": {"deny": ["slack send-message", "curl"]},
        },
    },
    # e2b 沙箱是一台机器；remote 运行时在其上运行程序
    machines={"box": {"provider": "e2b", "sandbox_id": sandbox_id, "mount_type": "ssh"}},
    runtimes=[
        MontyRuntime(captures=["python", "python3"]),
        RemoteRuntime(captures=["python", "python3"], machine="box"),
    ],
    # 路由底层计算：含 numpy 的命令行在机器上运行，其余在 monty 上
    route_policy=lambda ctx: "remote" if "numpy" in ctx.line else None,
)

# 添加一个使用 analyst Profile 的 Agent
alice = await ws.session("alice", profile="analyst")

# 一次 grep 扫遍 S3、Slack 和 Gmail，有自带搜索的服务就用它自己的搜索
await alice.shell("grep -rlw invoice /s3 /slack /gmail")

# 在 monty 上运行存放在 Slack 里的脚本，把报告写入 S3
await alice.shell("python3 /slack/channels/general__C0123/2026-10-21/files/report__F0456.py > /s3/report.txt")

# monty 中没有 numpy，所以路由策略把这一行发送到 e2b
await alice.shell("python3 -c 'import numpy; print(numpy.arange(10).sum())'")
```

`alice` 在 Shell 中看到的是：

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

## 关于

- **统一的虚拟终端接口，而不是 N 个 SDK 和 M 个 MCP。** 每个后端都使用同一套文件系统语义，管道可以跨服务组合。
- **覆盖所有数据源的虚拟文件系统。** S3、Google Drive、Slack、Gmail、Redis 等并排挂载在同一个根目录下，Agent 通过统一接口，用它已经会的 unix 工具（如 `ls`、`grep`、`find` 和 `jq`）访问全部数据源。
- **虚拟命令行工具（CLI）。** `git`、`slack` 和 `ntn` 由 Mirage 自己应答，Agent 无需安装任何东西即可驱动这些服务，并可跨不同运行时和机器；同一个工具还能虚拟成两个或更多，各自使用独立的名称和凭据。
- **动态路由的运行时。** Python、JavaScript 以及任何其他命令都可以被发送到所配置的运行时，进程内、沙箱或远程，从而把计算与存储解耦，任何一方都可以独立更换。
- **虚拟化的 Mirage Shell。** 它把文件系统、CLI 和运行时绑定到同一条命令行上，因此管道、重定向、变量、作业和历史记录在三者之间都可用。
- **轻量化设计。** 工作区，也就是虚拟终端本身，约占 100 KB 内存，每个新会话约 10 KB，因此一个进程即可服务许多 Agent，无需为每个 Agent 准备容器或虚拟机。
- **为 Agent 设计的 Profile。** `allow`、`ask` 和 `deny` 管控命令和 CLI，`hide` 和 `show` 管控文件和目录，因此被隐藏的路径不只是不可读，而是在 Agent 看到的文件系统中根本不存在。
- **可脚本化的策略引擎。** 策略脚本可以在任何危险操作执行前将其阻止，同一套策略栈还会拦截每一次 VFS 操作和会话写入，因此文件和环境变量都不会泄露。
- **接入 VFS 与 Agent 的通知。** 外部变更会成为挂载上的事件流，因此一条新的 Slack 回复会表现为虚拟文件系统中聊天文件的变化，Agent 直接据此响应，而不必重新扫描整棵树。

## 虚拟文件系统

[Mirage](https://www.strukto.ai/mirage) 把一切“挂载”为一个面向 AI Agent 的统一虚拟文件系统。每个服务并排位于同一个根目录下，并遵循相同的 POSIX 语义。

|                      | VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **对象存储**         | <a href="https://aws.amazon.com/s3/"><img src="https://api.iconify.design/logos/aws-s3.svg" width="20" height="20" alt="Amazon S3" title="Amazon S3" /></a>  <a href="https://developers.cloudflare.com/r2/"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare R2" title="Cloudflare R2" /></a>  <a href="https://cloud.google.com/storage"><img src="https://api.iconify.design/logos/google-cloud.svg" width="25" height="20" alt="Google Cloud Storage" title="Google Cloud Storage" /></a>  <a href="https://www.oracle.com/cloud/storage/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/oracle.svg" width="32" height="20" alt="Oracle OCI" title="Oracle OCI" /></a>  <a href="https://supabase.com/storage"><img src="https://api.iconify.design/logos/supabase-icon.svg" width="19" height="20" alt="Supabase Storage" title="Supabase Storage" /></a>  <a href="https://min.io"><img src="https://cdn.simpleicons.org/minio" width="20" height="20" alt="MinIO" title="MinIO" /></a>  <a href="https://ceph.io/en/discover/technology/"><img src="https://cdn.simpleicons.org/ceph" width="20" height="20" alt="Ceph" title="Ceph" /></a>  <a href="https://github.com/seaweedfs/seaweedfs"><img src="../assets/icons/seaweedfs.svg" width="20" height="20" alt="SeaweedFS" title="SeaweedFS" /></a>  <a href="https://wasabi.com/cloud-object-storage"><img src="https://cdn.simpleicons.org/wasabi" width="20" height="20" alt="Wasabi" title="Wasabi" /></a>  <a href="https://www.backblaze.com/cloud-storage"><img src="https://cdn.simpleicons.org/backblaze" width="20" height="20" alt="Backblaze B2" title="Backblaze B2" /></a>  <a href="https://www.digitalocean.com/products/spaces"><img src="https://cdn.simpleicons.org/digitalocean" width="20" height="20" alt="DigitalOcean Spaces" title="DigitalOcean Spaces" /></a>  <a href="https://www.alibabacloud.com/product/oss"><img src="https://cdn.simpleicons.org/alibabacloud" width="20" height="20" alt="Alibaba Cloud OSS" title="Alibaba Cloud OSS" /></a>  <a href="https://www.tencentcloud.com/products/cos"><img src="../assets/icons/tencent.png" width="20" height="20" alt="Tencent Cloud COS" title="Tencent Cloud COS" /></a>  <a href="https://www.scaleway.com/en/object-storage/"><img src="https://cdn.simpleicons.org/scaleway" width="20" height="20" alt="Scaleway" title="Scaleway" /></a>  <a href="https://www.qingcloud.com/products/qingstor"><img src="../assets/icons/qingstor.png" width="20" height="20" alt="QingStor" title="QingStor" /></a>  <a href="https://huggingface.co/docs/hub/storage-buckets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Buckets" title="Hugging Face Buckets" /></a>  <a href="https://www.mongodb.com/docs/manual/core/gridfs/"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="GridFS" title="GridFS" /></a> |
| **文件与文档**       | <a href="https://workspace.google.com/products/drive/"><img src="https://cdn.simpleicons.org/googledrive" width="20" height="20" alt="Google Drive" title="Google Drive" /></a>  <a href="https://docs.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-docs.svg" width="14" height="20" alt="Google Docs" title="Google Docs" /></a>  <a href="https://sheets.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-sheets.svg" width="15" height="20" alt="Google Sheets" title="Google Sheets" /></a>  <a href="https://slides.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-slides.svg" width="15" height="20" alt="Google Slides" title="Google Slides" /></a>  <a href="https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-onedrive.svg" width="30" height="20" alt="OneDrive" title="OneDrive" /></a>  <a href="https://www.microsoft.com/microsoft-365/sharepoint/collaboration"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-sharepoint.svg" width="20" height="20" alt="SharePoint" title="SharePoint" /></a>  <a href="https://www.box.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/box.svg" width="20" height="20" alt="Box" title="Box" /></a>  <a href="https://www.dropbox.com"><img src="https://cdn.simpleicons.org/dropbox" width="20" height="20" alt="Dropbox" title="Dropbox" /></a>  <a href="https://nextcloud.com/files/"><img src="https://cdn.simpleicons.org/nextcloud" width="20" height="20" alt="Nextcloud" title="Nextcloud" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **消息与协作**       | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="Slack" title="Slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="Discord" title="Discord" /></a>  <a href="https://mail.google.com"><img src="https://cdn.simpleicons.org/gmail" width="20" height="20" alt="Gmail" title="Gmail" /></a>  <a href="https://en.wikipedia.org/wiki/Internet_Message_Access_Protocol"><img src="https://api.iconify.design/lucide/mail.svg?color=%23888888" width="20" height="20" alt="IMAP / SMTP email" title="IMAP / SMTP email" /></a>  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="GitHub" title="GitHub" /></a>  <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="Linear" title="Linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="Notion" title="Notion" /></a>  <a href="https://trello.com"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="Trello" title="Trello" /></a>  <a href="https://workspace.google.com/products/calendar/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-calendar.svg" width="20" height="20" alt="Google Calendar" title="Google Calendar" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **数据库与数据平台** | <a href="https://www.postgresql.org"><img src="https://cdn.simpleicons.org/postgresql" width="20" height="20" alt="PostgreSQL" title="PostgreSQL" /></a>  <a href="https://www.mongodb.com"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="MongoDB" title="MongoDB" /></a>  <a href="https://redis.io"><img src="https://cdn.simpleicons.org/redis" width="20" height="20" alt="Redis" title="Redis" /></a> <a href="https://upstash.com"><img src="https://cdn.simpleicons.org/upstash" width="20" height="20" alt="Upstash Redis" title="Upstash Redis" /></a>  <a href="https://lancedb.com"><img src="../assets/icons/lancedb.png" width="20" height="20" alt="LanceDB" title="LanceDB" /></a>  <a href="https://qdrant.tech"><img src="https://cdn.simpleicons.org/qdrant" width="20" height="20" alt="Qdrant" title="Qdrant" /></a>  <a href="https://www.trychroma.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/chroma.svg" width="31" height="20" alt="Chroma" title="Chroma" /></a>  <a href="https://mem0.ai"><img src="../docs/images/mem0.svg" width="20" height="20" alt="Mem0" title="Mem0" /></a>  <a href="https://huggingface.co/datasets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Datasets" title="Hugging Face Datasets" /></a>  <a href="https://huggingface.co/models"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Models" title="Hugging Face Models" /></a>  <a href="https://huggingface.co/spaces"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Spaces" title="Hugging Face Spaces" /></a>  <a href="https://docs.databricks.com/aws/en/volumes/"><img src="https://cdn.simpleicons.org/databricks" width="20" height="20" alt="Databricks Volumes" title="Databricks Volumes" /></a>  <a href="https://dify.ai"><img src="https://cdn.simpleicons.org/dify" width="20" height="20" alt="Dify" title="Dify" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **可观测性**         | <a href="https://langfuse.com"><img src="../docs/images/langfuse-logo.svg" width="20" height="20" alt="Langfuse" title="Langfuse" /></a>  <a href="https://www.jaegertracing.io"><img src="https://cdn.simpleicons.org/jaeger" width="20" height="20" alt="Jaeger" title="Jaeger" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **本地与远程**       | <a href="https://en.wikipedia.org/wiki/Random-access_memory"><img src="https://api.iconify.design/lucide/memory-stick.svg?color=%23888888" width="20" height="20" alt="RAM" title="RAM" /></a>  <a href="https://en.wikipedia.org/wiki/File_system"><img src="https://api.iconify.design/lucide/hard-drive.svg?color=%23888888" width="20" height="20" alt="Disk" title="Disk" /></a>  <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system"><img src="https://api.iconify.design/lucide/folder-lock.svg?color=%23888888" width="20" height="20" alt="OPFS" title="OPFS" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Agent 可以通过 Python 和 TypeScript SDK、`mirage` CLI，或基于 FUSE 和 FSKit 的真实挂载点访问它，再用已经熟悉的 unix 工具操作，如 `ls`、`grep`、`find` 和 `jq`。

## 虚拟命令行工具

这些命令行工具是虚拟化的：[Mirage](https://www.strukto.ai/mirage) 自己应答 `git`、`slack` 或 `ntn`，因此 Agent 无需在机器上安装对应程序即可驱动服务。每个工具都模仿真实工具，熟悉该 CLI 的 Agent 无需学习新东西。由于它们是虚拟的，同一个工具可以用不同名称安装多次，各自使用独立的凭据，因此每个 Agent 拿到的恰好是分配给它的账号。

|                | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **代码**       | <a href="https://git-scm.com"><img src="https://cdn.simpleicons.org/git" width="20" height="20" alt="git" title="git" /></a>  <a href="https://cli.github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="gh" title="gh" /></a>                                                                                                                                                                                                                                                                                           |
| **沟通**       | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="slack" title="slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="discord" title="discord" /></a>  <a href="https://github.com/pimalaya/himalaya"><img src="../assets/icons/himalaya.png" width="20" height="20" alt="himalaya" title="himalaya" /></a>                                                                                                                         |
| **工作与数据** | <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="linear" title="linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="ntn" title="ntn" /></a>  <a href="https://workspace.google.com"><img src="https://cdn.simpleicons.org/google" width="20" height="20" alt="gws" title="gws" /></a>  <a href="https://huggingface.co"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="hf" title="hf" /></a> |

## 虚拟运行时

运行时以同样的方式虚拟化，而且不只针对编程语言。命令行上的任何命令都可以被重定向到所配置的运行时，例如 Python 可以借助 [Monty](https://pydantic.dev/articles/pydantic-monty) 在进程内运行，而另一个命令（比如 `kubectl`）则通过 SSH 发送到远程机器。某一行由哪个运行时处理，可以交给[脚本化的运行时路由器](https://docs.mirage.strukto.ai/home/policy/route-runtime)决定。

|                | 运行时                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**     | <a href="https://pydantic.dev/articles/pydantic-monty"><img src="https://cdn.simpleicons.org/pydantic" width="20" height="20" alt="Monty" title="Monty" /></a>  <a href="https://wasi.dev"><img src="https://cdn.simpleicons.org/webassembly" width="20" height="20" alt="WASI CPython on wasmtime" title="WASI CPython on wasmtime" /></a>  <a href="https://pyodide.org"><img src="../assets/icons/pyodide.svg" width="56" height="20" alt="Pyodide" title="Pyodide" /></a>  <a href="https://pypi.org/project/sandlock/"><img src="../docs/images/sandlock-logo.svg" width="20" height="20" alt="sandlock" title="sandlock" /></a>  <a href="https://www.python.org"><img src="https://cdn.simpleicons.org/python" width="20" height="20" alt="Host CPython" title="Host CPython" /></a>                                                                                                                                                                                                                                                   |
| **JavaScript** | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="../assets/icons/quickjs.png" width="20" height="20" alt="QuickJS, serving node and js" title="QuickJS, serving node and js" /></a> <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><img src="https://cdn.simpleicons.org/javascript" width="20" height="20" alt="JavaScript" title="JavaScript" /></a> <a href="https://www.typescriptlang.org"><img src="https://cdn.simpleicons.org/typescript" width="20" height="20" alt="TypeScript" title="TypeScript" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **机器**       | <a href="https://www.docker.com"><img src="https://cdn.simpleicons.org/docker" width="20" height="20" alt="Docker" title="Docker" /></a>  <a href="https://e2b.dev"><img src="../docs/images/e2b-logo.svg" width="20" height="20" alt="E2B" title="E2B" /></a>  <a href="https://www.daytona.io"><img src="../docs/images/daytona-logo.svg" width="20" height="20" alt="Daytona" title="Daytona" /></a>  <a href="https://smolmachines.com"><img src="../docs/images/smolvm-logo.svg" width="20" height="20" alt="smolVM" title="smolVM" /></a> <a href="https://microsandbox.dev"><img src="../docs/images/microsandbox-logo.svg" width="20" height="20" alt="Microsandbox" title="Microsandbox" /></a> <a href="https://github.com/apple/container"><img src="https://cdn.simpleicons.org/apple/000000/e6edf3" width="20" height="20" alt="Apple Container" title="Apple Container" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a> |

## 安全

Profile 决定一个会话可以运行什么、可以看到什么。命令由可自定义的 `allow`、`ask` 和 `deny` 规则管控，路径由 `hide` 和 `show` 管控，因此被隐藏的文件不只是不可读，而是在 Agent 看到的文件系统中根本不存在。对于这些规则无法表达的情况，Profile 可以指定一个策略脚本，它在每条命令的关口运行，自行答复 allow、deny 或 ask；但和所有规则一样，它只能收紧权限，不能授予权限。此外，宿主程序还可以在[策略引擎](https://docs.mirage.strukto.ai/home/policy/policies)上注册自己的策略，这是一个有序的策略栈，工作区会在每条命令、每次 VFS 操作和会话写入时查询它。参见[策略文档](https://docs.mirage.strukto.ai/home/policy/overview)。

## 服务凭据

服务凭据可以对接密钥已经存放的位置，包括 AWS Secrets Manager、1Password 和 dotenv，因此 Mirage 中的环境变量可以直接解析为其中某处保存的凭据。

|            | 来源                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **内置**   | <a href="https://en.wikipedia.org/wiki/Environment_variable"><img src="../assets/icons/terminal.svg" width="20" height="20" alt="Environment" title="Environment" /></a> <a href="https://www.dotenv.org"><img src="https://cdn.simpleicons.org/dotenv" width="20" height="20" alt="dotenv" title="dotenv" /></a>                                          |
| **自定义** | <a href="https://1password.com"><img src="https://cdn.simpleicons.org/1password" width="20" height="20" alt="1Password" title="1Password" /></a> <a href="https://aws.amazon.com/secrets-manager/"><img src="https://api.iconify.design/logos/aws-secrets-manager.svg" width="20" height="20" alt="AWS Secrets Manager" title="AWS Secrets Manager" /></a> |

## 安装

- **Python** ≥ 3.12，用于 `mirage-ai` 包和 `mirage` CLI
- **Node.js** Node 22 需 22.20+，Node 24 需 24.12+，或 25+，用于 TypeScript SDK

### Python

```bash
uv add mirage-ai              # 安装 `mirage` 库和 `mirage` CLI 二进制
uv add 'mirage-ai[openai]'    # OpenAI Agents 适配器；每个 agent 框架是一个 extra
uv add 'mirage-ai[monty]'     # Monty：示例所用的进程内 Python 运行时
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js 服务器和 CLI
npm install @struktoai/mirage-browser   # 浏览器 / edge 运行时
npm install @struktoai/mirage-vercel    # Vercel AI 适配器；每个 agent 框架各有一个包
```

两个运行时包都会自动引入 `@struktoai/mirage-core`。

### CLI

```bash
npm install -g @struktoai/mirage-cli
# 或
uvx --from mirage-ai mirage
# 或
npx @struktoai/mirage-cli
```

快速上手请参阅 [Python](https://docs.mirage.strukto.ai/python/quickstart)、[TypeScript](https://docs.mirage.strukto.ai/typescript/quickstart) 和 [CLI](https://docs.mirage.strukto.ai/home/access/cli) 的快速开始指南。

## 可脚本化的策略

对于规则无法表达的情况，Profile 可以指定策略脚本。脚本的 `pre_command` 接收命令，可以打开命令中指定的文件，并返回 deny、ask 或 `None`。下面这个脚本禁用 `rm`，以及代码会删除文件的 Python 脚本：

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

在 Profile 中注册它，这里让它在每条命令之前于 Monty 上运行：

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

脚本还能在哪些其他阶段作答，参见[策略脚本](https://docs.mirage.strukto.ai/home/policy/scripts)。

## 嵌入式终端

大多数时候，Agent 需要的不是沙箱，而只是一个类似终端的接口，Mirage 可以把它嵌入应用服务器。每个终端都是一个 Mirage 会话，拥有自己的工作目录、环境和历史记录，Python 在进程内通过 Monty 运行，因此启动终端无需容器或虚拟机。下面是 Express 版本；FastAPI 版本见[文档](https://docs.mirage.strukto.ai/home/examples/embedded-terminal)。

```bash
npm install @struktoai/mirage-node @pydantic/monty express
```

```ts
import express from 'express'
import { MontyRuntime, MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

const ws = new Workspace(
  { '/work': new RAMVFS() },
  { mode: MountMode.EXEC, runtimes: [new MontyRuntime({ captures: ['python', 'python3'] })] },
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

## 贡献者

感谢所有为 Mirage 做出贡献的人。

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 贡献者" />
</a>
