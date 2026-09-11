<h1 align="center">
  <a href="https://www.strukto.ai/mirage">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/mirage-header-dark.svg">
      <img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/mirage-header-light.svg" width="100%" alt="Mirage: A Virtual Terminal for AI Agents" />
    </picture>
  </a>
</h1>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Documentation">
        <img src="https://img.shields.io/badge/mirage-docs-0C0C0C?labelColor=F0ECE2" /></a>
    <a href="https://github.com/strukto-ai/mirage/releases" alt="Status">
        <img src="https://img.shields.io/badge/status-preview-0C0C0C?labelColor=F0ECE2" alt="Status: preview" /></a>
    <a href="https://www.strukto.ai" alt="Website">
        <img src="https://img.shields.io/badge/made by-strukto.ai-0C0C0C?labelColor=F0ECE2" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="License">
        <img src="https://img.shields.io/badge/license-Apache--2.0-0C0C0C?labelColor=F0ECE2" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord">
        <img src="https://img.shields.io/badge/discord-join-0C0C0C?labelColor=F0ECE2&logo=discord&logoColor=0C0C0C" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Python docs">
        <img src="https://img.shields.io/badge/python-docs-0C0C0C?labelColor=F0ECE2&logo=python&logoColor=0C0C0C" alt="Python docs"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="PyPI Version">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=F0ECE2"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="TypeScript docs">
        <img src="https://img.shields.io/badge/typescript-docs-0C0C0C?labelColor=F0ECE2&logo=typescript&logoColor=0C0C0C" alt="TypeScript docs"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-node" alt="NPM Version">
        <img src="https://img.shields.io/npm/v/@struktoai/mirage-node.svg?color=0C0C0C&labelColor=F0ECE2"/></a>
</p>

<p align="center">
  <a href="https://github.com/strukto-ai/mirage/blob/main/README.md"><img alt="README in English" src="https://img.shields.io/badge/English-F0ECE2"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.zh-CN.md"><img alt="简体中文 README" src="https://img.shields.io/badge/简体中文-F0ECE2"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.zh-TW.md"><img alt="繁體中文 README" src="https://img.shields.io/badge/繁體中文-F0ECE2"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.fr.md"><img alt="README en Français" src="https://img.shields.io/badge/Français-F0ECE2"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.de.md"><img alt="README auf Deutsch" src="https://img.shields.io/badge/Deutsch-F0ECE2"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-F0ECE2"></a>
  <a href="https://github.com/strukto-ai/mirage/blob/main/readme/README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-F0ECE2"></a>
</p>

Mirage is **a Virtual Terminal for AI Agents**. The virtual filesystem delivers broad data context, virtualized CLIs give an agent more flexibility on tool use, dynamic runtimes save underlying infrastructure cost and are more token efficient, and fine-grained control over an agent's actions and even over what it can see gives the best security. Together these parts form one virtualized terminal, giving the best agent performance, cost efficiency and security.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/mirage-arch-dark.svg">
    <img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/mirage-arch-light.svg" alt="Mirage architecture: agents and harness reach profiles and the Mirage shell, which resolve Unix-like commands, virtual CLIs and programming languages onto runtimes and the virtual filesystem, with authentication, the policy engine and notifications alongside" width="100%">
  </picture>
</p>

Here is an example of launching Mirage inside an application:

```python
ws = Workspace(
    {
        "/tmp":   (RAMResource(), MountMode.EXEC),
        "/redis": (RedisResource(url=redis_url), MountMode.WRITE),
        "/slack": (SlackResource(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
    },
    # monty captures python, so scripts run sandboxed inside the workspace
    runtimes=[MontyRuntime(captures=["python", "python3"]), "vfs"],
)

# one grep sweeps every source
await ws.execute("grep -rln session /redis /tmp")

# run a script that lives in Slack, file the report into Redis
await ws.execute("python3 /slack/channels/general_.../files/example__F....py > /redis/report.txt")

# install a typed CLI under a head word: dispatched by name, not by path,
# and discoverable through `man`, `type` and `which` like any other program
ws.register_cli("slack", SLACK, {"token": slack_bot_token})
await ws.execute('slack send-message --channel general --text "report is up"')
```

## About

- **Unified virtual terminal interface, not N SDKs and M MCPs.** Every backend speaks the same filesystem semantics, so pipelines compose across services.
- **A virtual filesystem over every source.** S3, Google Drive, Slack, Gmail, Redis and the rest mount side by side under one root, so an agent reaches all of them through a unified interface with the unix tools it already knows, like `ls`, `grep`, `find` and `jq`.
- **Virtual command line tools (CLIs).** `git`, `slack` and `ntn` are answered by Mirage itself, so an agent drives the service with nothing installed, across different runtimes and machines, and one tool can be virtualized into two or more, each under its own name with its own credentials.
- **Routed, dynamic runtimes.** Python, JavaScript and any other command can be sent to a configured runtime, in process, sandboxed or remote, which decouples computation from storage and lets either change without touching the other.
- **The virtualized Mirage shell.** It binds the filesystem, the CLIs and the runtimes into one command line, so pipes, redirection, variables, jobs and history work across all three.
- **Profiles designed for agents.** `allow`, `ask` and `deny` govern commands and CLIs, while `hide` and `show` govern files and folders, so a hidden path is not merely unreadable but absent from the filesystem the agent sees.
- **A scriptable policy engine.** A policy script can prohibit any dangerous action before it runs, and the same stack gates every VFS op and session write, so neither a file nor an environment variable leaks.
- **Notifications wired into the VFS and agents.** External changes become an event stream on the mount, so a new Slack reply surfaces as a change to the chat file in the virtual filesystem, and the agent reacts to it instead of rescanning the tree.

## Virtual Filesystem

Everything [Mirage](https://www.strukto.ai/mirage) "mounts" as one unified virtual filesystem for AI agents. Each
service sits side-by-side under a single root and answers the same POSIX semantics.

|                                  | Resources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Object Storage**               | <a href="https://aws.amazon.com/s3/"><img src="https://api.iconify.design/logos/aws-s3.svg" width="20" height="20" alt="Amazon S3" title="Amazon S3" /></a>  <a href="https://developers.cloudflare.com/r2/"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare R2" title="Cloudflare R2" /></a>  <a href="https://cloud.google.com/storage"><img src="https://api.iconify.design/logos/google-cloud.svg" width="25" height="20" alt="Google Cloud Storage" title="Google Cloud Storage" /></a>  <a href="https://www.oracle.com/cloud/storage/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/oracle.svg" width="32" height="20" alt="Oracle OCI" title="Oracle OCI" /></a>  <a href="https://supabase.com/storage"><img src="https://api.iconify.design/logos/supabase-icon.svg" width="19" height="20" alt="Supabase Storage" title="Supabase Storage" /></a>  <a href="https://min.io"><img src="https://cdn.simpleicons.org/minio" width="20" height="20" alt="MinIO" title="MinIO" /></a>  <a href="https://ceph.io/en/discover/technology/"><img src="https://cdn.simpleicons.org/ceph" width="20" height="20" alt="Ceph" title="Ceph" /></a>  <a href="https://github.com/seaweedfs/seaweedfs"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/seaweedfs.svg" width="20" height="20" alt="SeaweedFS" title="SeaweedFS" /></a>  <a href="https://wasabi.com/cloud-object-storage"><img src="https://cdn.simpleicons.org/wasabi" width="20" height="20" alt="Wasabi" title="Wasabi" /></a>  <a href="https://www.backblaze.com/cloud-storage"><img src="https://cdn.simpleicons.org/backblaze" width="20" height="20" alt="Backblaze B2" title="Backblaze B2" /></a>  <a href="https://www.digitalocean.com/products/spaces"><img src="https://cdn.simpleicons.org/digitalocean" width="20" height="20" alt="DigitalOcean Spaces" title="DigitalOcean Spaces" /></a>  <a href="https://www.alibabacloud.com/product/oss"><img src="https://cdn.simpleicons.org/alibabacloud" width="20" height="20" alt="Alibaba Cloud OSS" title="Alibaba Cloud OSS" /></a>  <a href="https://www.tencentcloud.com/products/cos"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/tencent.png" width="20" height="20" alt="Tencent Cloud COS" title="Tencent Cloud COS" /></a>  <a href="https://www.scaleway.com/en/object-storage/"><img src="https://cdn.simpleicons.org/scaleway" width="20" height="20" alt="Scaleway" title="Scaleway" /></a>  <a href="https://www.qingcloud.com/products/qingstor"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/qingstor.png" width="20" height="20" alt="QingStor" title="QingStor" /></a>  <a href="https://huggingface.co/docs/hub/storage-buckets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Buckets" title="Hugging Face Buckets" /></a>  <a href="https://www.mongodb.com/docs/manual/core/gridfs/"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="GridFS" title="GridFS" /></a> |
| **Files and Documents**          | <a href="https://workspace.google.com/products/drive/"><img src="https://cdn.simpleicons.org/googledrive" width="20" height="20" alt="Google Drive" title="Google Drive" /></a>  <a href="https://docs.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-docs.svg" width="14" height="20" alt="Google Docs" title="Google Docs" /></a>  <a href="https://sheets.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-sheets.svg" width="15" height="20" alt="Google Sheets" title="Google Sheets" /></a>  <a href="https://slides.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-slides.svg" width="15" height="20" alt="Google Slides" title="Google Slides" /></a>  <a href="https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-onedrive.svg" width="30" height="20" alt="OneDrive" title="OneDrive" /></a>  <a href="https://www.microsoft.com/microsoft-365/sharepoint/collaboration"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-sharepoint.svg" width="20" height="20" alt="SharePoint" title="SharePoint" /></a>  <a href="https://www.box.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/box.svg" width="20" height="20" alt="Box" title="Box" /></a>  <a href="https://www.dropbox.com"><img src="https://cdn.simpleicons.org/dropbox" width="20" height="20" alt="Dropbox" title="Dropbox" /></a>  <a href="https://nextcloud.com/files/"><img src="https://cdn.simpleicons.org/nextcloud" width="20" height="20" alt="Nextcloud" title="Nextcloud" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Messaging and Work**           | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="Slack" title="Slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="Discord" title="Discord" /></a>  <a href="https://mail.google.com"><img src="https://cdn.simpleicons.org/gmail" width="20" height="20" alt="Gmail" title="Gmail" /></a>  <a href="https://en.wikipedia.org/wiki/Internet_Message_Access_Protocol"><img src="https://api.iconify.design/lucide/mail.svg?color=%23888888" width="20" height="20" alt="IMAP / SMTP email" title="IMAP / SMTP email" /></a>  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="GitHub" title="GitHub" /></a>  <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="Linear" title="Linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="Notion" title="Notion" /></a>  <a href="https://trello.com"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="Trello" title="Trello" /></a>  <a href="https://workspace.google.com/products/calendar/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-calendar.svg" width="20" height="20" alt="Google Calendar" title="Google Calendar" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Databases and Data Platforms** | <a href="https://www.postgresql.org"><img src="https://cdn.simpleicons.org/postgresql" width="20" height="20" alt="PostgreSQL" title="PostgreSQL" /></a>  <a href="https://www.mongodb.com"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="MongoDB" title="MongoDB" /></a>  <a href="https://redis.io"><img src="https://cdn.simpleicons.org/redis" width="20" height="20" alt="Redis" title="Redis" /></a> <a href="https://upstash.com"><img src="https://cdn.simpleicons.org/upstash" width="20" height="20" alt="Upstash Redis" title="Upstash Redis" /></a>  <a href="https://lancedb.com"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/lancedb.png" width="20" height="20" alt="LanceDB" title="LanceDB" /></a>  <a href="https://qdrant.tech"><img src="https://cdn.simpleicons.org/qdrant" width="20" height="20" alt="Qdrant" title="Qdrant" /></a>  <a href="https://www.trychroma.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/chroma.svg" width="31" height="20" alt="Chroma" title="Chroma" /></a>  <a href="https://mem0.ai"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/mem0.svg" width="20" height="20" alt="Mem0" title="Mem0" /></a>  <a href="https://huggingface.co/datasets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Datasets" title="Hugging Face Datasets" /></a>  <a href="https://huggingface.co/models"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Models" title="Hugging Face Models" /></a>  <a href="https://huggingface.co/spaces"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Spaces" title="Hugging Face Spaces" /></a>  <a href="https://docs.databricks.com/aws/en/volumes/"><img src="https://cdn.simpleicons.org/databricks" width="20" height="20" alt="Databricks Volumes" title="Databricks Volumes" /></a>  <a href="https://dify.ai"><img src="https://cdn.simpleicons.org/dify" width="20" height="20" alt="Dify" title="Dify" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Observability**                | <a href="https://langfuse.com"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/langfuse-logo.svg" width="20" height="20" alt="Langfuse" title="Langfuse" /></a>  <a href="https://www.jaegertracing.io"><img src="https://cdn.simpleicons.org/jaeger" width="20" height="20" alt="Jaeger" title="Jaeger" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Local and Remote**             | <a href="https://en.wikipedia.org/wiki/Random-access_memory"><img src="https://api.iconify.design/lucide/memory-stick.svg?color=%23888888" width="20" height="20" alt="RAM" title="RAM" /></a>  <a href="https://en.wikipedia.org/wiki/File_system"><img src="https://api.iconify.design/lucide/hard-drive.svg?color=%23888888" width="20" height="20" alt="Disk" title="Disk" /></a>  <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system"><img src="https://api.iconify.design/lucide/folder-lock.svg?color=%23888888" width="20" height="20" alt="OPFS" title="OPFS" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Agents reach it through the Python and TypeScript SDKs, the `mirage` CLI, or a real
mountpoint over FUSE and FSKit, then work it with the unix tools they already know,
like `ls`, `grep`, `find` and `jq`.

## Virtual Command Line Tool

These command line tools are virtualized: [Mirage](https://www.strukto.ai/mirage) answers `git`, `slack` or `ntn`
itself, so an agent drives the service without that program being installed on the
machine. Each one mimics the real tool, so an agent that knows the CLI needs nothing
new. Because they are virtual, the same tool can be installed more than once under
different names, each with its own credentials, so every agent gets exactly the
accounts it is given.

|                   | CLIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code**          | <a href="https://git-scm.com"><img src="https://cdn.simpleicons.org/git" width="20" height="20" alt="git" title="git" /></a>  <a href="https://cli.github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="gh" title="gh" /></a>                                                                                                                                                                                                                                                                                           |
| **Communication** | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="slack" title="slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="discord" title="discord" /></a>  <a href="https://github.com/pimalaya/himalaya"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/himalaya.png" width="20" height="20" alt="himalaya" title="himalaya" /></a>                                                                   |
| **Work and Data** | <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="linear" title="linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="ntn" title="ntn" /></a>  <a href="https://workspace.google.com"><img src="https://cdn.simpleicons.org/google" width="20" height="20" alt="gws" title="gws" /></a>  <a href="https://huggingface.co"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="hf" title="hf" /></a> |

## Virtual Runtime

Runtimes are virtualized the same way, and not only for coding languages. Any
command on the line can be redirected to a configured runtime, so Python might
run in-process with [Monty](https://pydantic.dev/articles/pydantic-monty) while
another command, say `kubectl`, is sent to a remote machine over SSH. Which runtime
serves a given line can be decided by a
[scripted runtime router](https://docs.mirage.strukto.ai/home/route-policy).

|                | Runtimes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Python**     | <a href="https://pydantic.dev/articles/pydantic-monty"><img src="https://cdn.simpleicons.org/pydantic" width="20" height="20" alt="Monty" title="Monty" /></a>  <a href="https://wasi.dev"><img src="https://cdn.simpleicons.org/webassembly" width="20" height="20" alt="WASI CPython on wasmtime" title="WASI CPython on wasmtime" /></a>  <a href="https://pyodide.org"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/pyodide.svg" width="56" height="20" alt="Pyodide" title="Pyodide" /></a>  <a href="https://pypi.org/project/sandlock/"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/sandlock-logo.svg" width="20" height="20" alt="sandlock" title="sandlock" /></a>  <a href="https://www.python.org"><img src="https://cdn.simpleicons.org/python" width="20" height="20" alt="Host CPython" title="Host CPython" /></a>                  |
| **JavaScript** | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/javascript"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/quickjs.png" width="20" height="20" alt="QuickJS, serving node and js" title="QuickJS, serving node and js" /></a> <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><img src="https://cdn.simpleicons.org/javascript" width="20" height="20" alt="JavaScript" title="JavaScript" /></a> <a href="https://www.typescriptlang.org"><img src="https://cdn.simpleicons.org/typescript" width="20" height="20" alt="TypeScript" title="TypeScript" /></a>                                                                                                                                                                                                                                                                                             |
| **Sandboxes**  | <a href="https://www.docker.com"><img src="https://cdn.simpleicons.org/docker" width="20" height="20" alt="Docker" title="Docker" /></a>  <a href="https://e2b.dev"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/e2b-logo.svg" width="20" height="20" alt="E2B" title="E2B" /></a>  <a href="https://www.daytona.io"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/daytona-logo.svg" width="20" height="20" alt="Daytona" title="Daytona" /></a>  <a href="https://smolmachines.com"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/smolvm-logo.svg" width="20" height="20" alt="smolVM" title="smolVM" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a> |

## Security

A profile decides what a session may run and what it may see. Commands are governed
by customizable `allow`, `ask` and `deny` rules, and paths by `hide` and `show`, so a
hidden file is not merely unreadable but absent from the filesystem the agent sees.
For anything those rules cannot express, a profile can name a policy script that runs
at the gate on every command and answers allow, deny or ask itself, though like every
rule it can only restrict and never grant. Separately, a host can register its own
policies on the [policy engine](https://docs.mirage.strukto.ai/home/policy-engine), an
ordered stack the workspace consults on every command, VFS op and session write. See
the [permissions docs](https://docs.mirage.strukto.ai/home/permissions).

## Authentication

Credentials and authentication integrate with the stores secrets already live in,
including AWS Secrets Manager, 1Password, Auth0 and dotenv, so an environment variable
in Mirage can resolve straight to a credential held in one of them.

|              | Sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Built in** | <a href="https://en.wikipedia.org/wiki/Environment_variable"><img src="https://raw.githubusercontent.com/strukto-ai/mirage/main/assets/icons/terminal.svg" width="20" height="20" alt="Environment" title="Environment" /></a> <a href="https://www.dotenv.org"><img src="https://cdn.simpleicons.org/dotenv" width="20" height="20" alt="dotenv" title="dotenv" /></a> <a href="https://aws.amazon.com/secrets-manager/"><img src="https://api.iconify.design/logos/aws-secrets-manager.svg" width="20" height="20" alt="AWS Secrets Manager" title="AWS Secrets Manager" /></a> |
| **Custom**   | <a href="https://1password.com"><img src="https://cdn.simpleicons.org/1password" width="20" height="20" alt="1Password" title="1Password" /></a> <a href="https://auth0.com"><img src="https://cdn.simpleicons.org/auth0" width="20" height="20" alt="Auth0" title="Auth0" /></a>                                                                                                                                                                                                                                                                                                 |

## Installation

- **Python** ≥ 3.11 for the `mirage-ai` package and the `mirage` CLI
- **Node.js** ≥ 20 for the TypeScript SDK

### Python

```bash
uv add mirage-ai    # installs the `mirage` library and the `mirage` CLI binary
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js servers and CLIs
npm install @struktoai/mirage-browser   # browser / edge runtimes
npm install @struktoai/mirage-agents    # OpenAI / Vercel AI / LangChain / Mastra adapters
```

Both runtime packages pull in `@struktoai/mirage-core` automatically.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
# or
npm install -g @struktoai/mirage-cli
# or
uvx mirage-ai
# or
npx @struktoai/mirage-cli
```

## Quickstart

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
  '/s3': new S3Resource({ bucket: 'my-bucket' }),
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

## Contributors

Thanks to everyone who has contributed to Mirage.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage contributors" />
</a>
