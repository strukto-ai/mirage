<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage：面向 AI Agent 的虛擬終端機" width="900">
  </picture>
</p>

<p align="center">
  <a href="https://agentvfs.org">
    <picture>
      <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-narrow-dark.svg">
      <source media="(max-width: 767px)" srcset="../assets/agentvfs-banner-narrow-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-dark.svg">
      <img src="../assets/agentvfs-banner-light.svg" width="900" alt="AgentVFS：開放、廠商中立的 AI Agent 虛擬檔案系統介面" />
    </picture>
  </a>
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="文件">
        <img src="https://img.shields.io/badge/mirage-%E6%96%87%E6%A1%A3-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="官網">
        <img src="https://img.shields.io/badge/strukto.ai-%E5%87%BA%E5%93%81-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="授權條款">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://doi.org/10.5281/zenodo.23504502" alt="DOI">
        <img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.23504502-0C0C0C?labelColor=FAFAFA" alt="DOI 10.5281/zenodo.23504502" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord 社群">
        <img src="https://img.shields.io/badge/discord-%E5%8A%A0%E5%85%A5-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <a href="../assets/wechat-qr-code.jpg" aria-label="微信社群">
        <img src="https://img.shields.io/badge/wechat-%E5%8A%A0%E5%85%A5-0C0C0C?labelColor=FAFAFA&logo=wechat&logoColor=0C0C0C" alt="微信社群" /></a>
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

AI Agent 在終端機中工作。Mirage 是一個**虛擬終端機**，它把終端機介面、資料儲存和運算機器彼此分開。Mirage 把每條命令路由到適合它的機器上，涵蓋容器、microVM、雲端沙箱和 SSH 主機等異質機器。檔案、CLI 和機器分別加入，因此它保持彈性、基礎設施成本低，並讓 Agent 以最有效率、最安全的方式工作。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-terminal-dark.svg">
    <img src="../assets/mirage-terminal-light.svg" alt="一個虛擬終端，建立在一個統一的虛擬檔案系統之上：每條命令在適合它的機器上執行，經過 Agent 的 allow、deny、show 和 hide 規則，其工作階段、作業和命令日誌保存在為它們選定的後端上" width="100%">
  </picture>
</p>

- **可控。** 決定每個 Agent 能觸及什麼，包括它能看到哪些檔案、它的虛擬檔案系統和 CLI 在不向它展示的情況下使用哪些憑證，以及由哪台機器執行它的每個程式。
- **可腳本化。** 整個終端機以程式碼或設定檔定義，從虛擬檔案系統、CLI 和機器，到各項規則，例如哪些命令需要審核、Agent 能拿回多少輸出。
- **託管式。** Mirage 管理虛擬終端機的基礎設施，由所選的後端組合而成。虛擬檔案系統放在 S3、Drive、資料庫或 RAM 上，工作和歷史記錄放在 RAM、Redis 或磁碟上，整個工作區可以儲存為快照。Agent 執行的每條命令都會被記錄，並可以作為 trace 傳送到 OpenTelemetry 後端。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage 架構：Agent 與 Harness 連接 Profile 和 Mirage Shell，兩者把類 Unix 命令、虛擬 CLI 和程式語言解析到機器、執行環境與虛擬檔案系統上，服務憑證、策略引擎和通知在旁" width="100%">
  </picture>
</p>

以下是在應用程式中啟動 Mirage 的範例：

```python
ws = Workspace(
    {
        "/s3":    (S3VFS(S3Config(bucket="my-bucket")), MountMode.WRITE),
        "/slack": (SlackVFS(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
        "/gmail": (GmailVFS(GmailConfig(**google_credentials)), MountMode.READ),
    },
    # 安裝 Slack CLI，依名稱執行，並像其他程式一樣出現在 `man` 和 `which` 中
    clis={"slack": (SLACK, {"token": slack_bot_token})},
    # analyst Profile 隱藏 /s3/secrets，並禁止向 Slack 發文和使用 curl
    profiles={
        "analyst": {
            "paths": {"hide": ["/s3/secrets"]},
            "commands": {"deny": ["slack send-message", "curl"]},
        },
    },
    # python 在行程內的 monty 上執行，或在 e2b 沙箱中執行
    machines={
        "py": {"provider": "in_process", "runtime": "monty"},
        "box": {"provider": "e2b", "sandbox_id": sandbox_id, "mount_type": "ssh", "captures": ["python", "python3"]},
    },
    # 路由底層運算：含 numpy 的命令列在機器上執行，其餘在 monty 上
    route_policy=lambda ctx: "box" if "numpy" in ctx.line else None,
)

# 新增一個使用 analyst Profile 的 Agent
alice = await ws.session("alice", profile="analyst")

# 一次 grep 掃遍 S3、Slack 和 Gmail，有內建搜尋的服務就用它自己的搜尋
await alice.shell("grep -rlw invoice /s3 /slack /gmail")

# 在 monty 上執行放在 Slack 裡的腳本，把報告寫入 S3
await alice.shell("python3 /slack/channels/general__C0123/2026-10-21/files/report__F0456.py > /s3/report.txt")

# monty 中沒有 numpy，所以路由策略把這一行送到 e2b
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

## 關於

- **統一的虛擬終端機介面，而不是 N 個 SDK 和 M 個 MCP。** 每個後端都使用同一套檔案系統語意，管線可以跨服務組合。
- **涵蓋所有資料來源的虛擬檔案系統。** S3、Google Drive、Slack、Gmail、Redis 等並排掛載在同一個根目錄下，Agent 透過統一介面，用它已經會的 unix 工具（如 `ls`、`grep`、`find` 和 `jq`）存取全部資料來源。
- **虛擬命令列工具（CLI）。** `git`、`slack` 和 `ntn` 由 Mirage 自己回應，Agent 無需安裝任何東西即可驅動這些服務，並可跨不同執行環境和機器；同一個工具還能虛擬成兩個或更多，各自使用獨立的名稱和憑證。
- **動態路由的機器。** Python、JavaScript 以及任何其他命令都可以被送到所設定的機器，行程內、沙箱或遠端，從而把運算與儲存解耦，任何一方都可以獨立更換。
- **虛擬化的 Mirage Shell。** 它把檔案系統、CLI 和機器綁定到同一條命令列上，因此管線、重新導向、變數、工作和歷史記錄在三者之間都可用。
- **輕量化設計。** 工作區，也就是虛擬終端機本身，約占 100 KB 記憶體，每個新工作階段約 10 KB，因此一個行程即可服務許多 Agent，無需為每個 Agent 準備容器或虛擬機。
- **為 Agent 設計的 Profile。** `allow`、`ask` 和 `deny` 管控命令和 CLI，`hide` 和 `show` 管控檔案和目錄，因此被隱藏的路徑不只是不可讀，而是在 Agent 看到的檔案系統中根本不存在。
- **可腳本化的策略引擎。** 策略腳本可以在任何危險操作執行前將其阻擋，同一套策略堆疊還會攔截每一次 VFS 操作和工作階段寫入，因此檔案和環境變數都不會外洩。
- **接入 VFS 與 Agent 的通知。** 外部變更會成為掛載上的事件串流，因此一則新的 Slack 回覆會表現為虛擬檔案系統中聊天檔案的變化，Agent 直接據此回應，而不必重新掃描整棵樹。

## 虛擬檔案系統

[Mirage](https://www.strukto.ai/mirage) 把一切「掛載」為一個面向 AI Agent 的統一虛擬檔案系統。每個服務並排位於同一個根目錄下，並遵循相同的 POSIX 語意。

|                      | VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **物件儲存**         | <a href="https://docs.mirage.strukto.ai/home/setup/s3"><img src="https://api.iconify.design/logos/aws-s3.svg" width="20" height="20" alt="Amazon S3" title="Amazon S3" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/r2"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare R2" title="Cloudflare R2" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/gcs"><img src="https://api.iconify.design/logos/google-cloud.svg" width="25" height="20" alt="Google Cloud Storage" title="Google Cloud Storage" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/oci"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/oracle.svg" width="32" height="20" alt="Oracle OCI" title="Oracle OCI" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/supabase"><img src="https://api.iconify.design/logos/supabase-icon.svg" width="19" height="20" alt="Supabase Storage" title="Supabase Storage" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/minio"><img src="https://cdn.simpleicons.org/minio" width="20" height="20" alt="MinIO" title="MinIO" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/ceph"><img src="https://cdn.simpleicons.org/ceph" width="20" height="20" alt="Ceph" title="Ceph" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/seaweedfs"><img src="../assets/icons/seaweedfs.svg" width="20" height="20" alt="SeaweedFS" title="SeaweedFS" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/wasabi"><img src="https://cdn.simpleicons.org/wasabi" width="20" height="20" alt="Wasabi" title="Wasabi" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/backblaze"><img src="https://cdn.simpleicons.org/backblaze" width="20" height="20" alt="Backblaze B2" title="Backblaze B2" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/digitalocean"><img src="https://cdn.simpleicons.org/digitalocean" width="20" height="20" alt="DigitalOcean Spaces" title="DigitalOcean Spaces" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/aliyun"><img src="https://cdn.simpleicons.org/alibabacloud" width="20" height="20" alt="Alibaba Cloud OSS" title="Alibaba Cloud OSS" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/tencent"><img src="../assets/icons/tencent.png" width="20" height="20" alt="Tencent Cloud COS" title="Tencent Cloud COS" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/scaleway"><img src="https://cdn.simpleicons.org/scaleway" width="20" height="20" alt="Scaleway" title="Scaleway" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/qingstor"><img src="../assets/icons/qingstor.png" width="20" height="20" alt="QingStor" title="QingStor" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/hf_buckets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Buckets" title="Hugging Face Buckets" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/gridfs"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="GridFS" title="GridFS" /></a> |
| **檔案與文件**       | <a href="https://docs.mirage.strukto.ai/home/setup/google"><img src="https://cdn.simpleicons.org/googledrive" width="20" height="20" alt="Google Drive" title="Google Drive" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/google"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-docs.svg" width="14" height="20" alt="Google Docs" title="Google Docs" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/google"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-sheets.svg" width="15" height="20" alt="Google Sheets" title="Google Sheets" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/google"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-slides.svg" width="15" height="20" alt="Google Slides" title="Google Slides" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/onedrive"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-onedrive.svg" width="30" height="20" alt="OneDrive" title="OneDrive" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/sharepoint"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-sharepoint.svg" width="20" height="20" alt="SharePoint" title="SharePoint" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/box"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/box.svg" width="20" height="20" alt="Box" title="Box" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/dropbox"><img src="https://cdn.simpleicons.org/dropbox" width="20" height="20" alt="Dropbox" title="Dropbox" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/nextcloud"><img src="https://cdn.simpleicons.org/nextcloud" width="20" height="20" alt="Nextcloud" title="Nextcloud" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/tidb"><img src="https://cdn.simpleicons.org/tidb" width="20" height="20" alt="TiDB Cloud Filesystem" title="TiDB Cloud Filesystem" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **訊息與協作**       | <a href="https://docs.mirage.strukto.ai/home/setup/slack"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="Slack" title="Slack" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/discord"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="Discord" title="Discord" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/google"><img src="https://cdn.simpleicons.org/gmail" width="20" height="20" alt="Gmail" title="Gmail" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/email"><img src="https://api.iconify.design/lucide/mail.svg?color=%23888888" width="20" height="20" alt="IMAP / SMTP email" title="IMAP / SMTP email" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/github"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="GitHub" title="GitHub" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/linear"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="Linear" title="Linear" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/notion"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="Notion" title="Notion" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/trello"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="Trello" title="Trello" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/gcal"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-calendar.svg" width="20" height="20" alt="Google Calendar" title="Google Calendar" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **資料庫與資料平台** | <a href="https://docs.mirage.strukto.ai/home/setup/postgres"><img src="https://cdn.simpleicons.org/postgresql" width="20" height="20" alt="PostgreSQL" title="PostgreSQL" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/mongodb"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="MongoDB" title="MongoDB" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/redis"><img src="https://cdn.simpleicons.org/redis" width="20" height="20" alt="Redis" title="Redis" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/redis"><img src="https://cdn.simpleicons.org/upstash" width="20" height="20" alt="Upstash Redis" title="Upstash Redis" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/sql"><img src="https://api.iconify.design/lucide/database.svg?color=%23888888" width="20" height="20" alt="SQL" title="SQL" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/airtable"><img src="https://cdn.simpleicons.org/airtable" width="20" height="20" alt="Airtable" title="Airtable" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/lancedb"><img src="../assets/icons/lancedb.png" width="20" height="20" alt="LanceDB" title="LanceDB" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/qdrant"><img src="https://cdn.simpleicons.org/qdrant" width="20" height="20" alt="Qdrant" title="Qdrant" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/chroma"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/chroma.svg" width="31" height="20" alt="Chroma" title="Chroma" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/mem0"><img src="../docs/images/mem0.svg" width="20" height="20" alt="Mem0" title="Mem0" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/hf_datasets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Datasets" title="Hugging Face Datasets" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/hf_models"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Models" title="Hugging Face Models" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/hf_spaces"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Spaces" title="Hugging Face Spaces" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/databricks"><img src="https://cdn.simpleicons.org/databricks" width="20" height="20" alt="Databricks Volumes" title="Databricks Volumes" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/dify"><img src="https://cdn.simpleicons.org/dify" width="20" height="20" alt="Dify" title="Dify" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **可觀測性**         | <a href="https://docs.mirage.strukto.ai/home/setup/langfuse"><img src="../docs/images/langfuse-logo.svg" width="20" height="20" alt="Langfuse" title="Langfuse" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/jaeger"><img src="https://cdn.simpleicons.org/jaeger" width="20" height="20" alt="Jaeger" title="Jaeger" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/wandb"><img src="https://cdn.simpleicons.org/weightsandbiases" width="20" height="20" alt="Weights & Biases" title="Weights & Biases" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **本機與遠端**       | <a href="https://docs.mirage.strukto.ai/home/setup/ram"><img src="https://api.iconify.design/lucide/memory-stick.svg?color=%23888888" width="20" height="20" alt="RAM" title="RAM" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/disk"><img src="https://api.iconify.design/lucide/hard-drive.svg?color=%23888888" width="20" height="20" alt="Disk" title="Disk" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/opfs"><img src="https://api.iconify.design/lucide/folder-lock.svg?color=%23888888" width="20" height="20" alt="OPFS" title="OPFS" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/ssh"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Agent 可以透過 Python 和 TypeScript SDK、`mirage` CLI，或基於 FUSE 和 FSKit 的真實掛載點存取它，再用已經熟悉的 unix 工具操作，如 `ls`、`grep`、`find` 和 `jq`。

## 虛擬命令列工具

這些命令列工具是虛擬化的：[Mirage](https://www.strukto.ai/mirage) 自己回應 `git`、`slack` 或 `ntn`，因此 Agent 無需在機器上安裝對應程式即可驅動服務。每個工具都模仿真實工具，熟悉該 CLI 的 Agent 無需學習新東西。由於它們是虛擬的，同一個工具可以用不同名稱安裝多次，各自使用獨立的憑證，因此每個 Agent 拿到的恰好是分配給它的帳號。

|                | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **程式碼**     | <a href="https://docs.mirage.strukto.ai/home/setup/cli/git"><img src="https://cdn.simpleicons.org/git" width="20" height="20" alt="git" title="git" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/cli/gh"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="gh" title="gh" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **溝通**       | <a href="https://docs.mirage.strukto.ai/home/setup/cli/slack"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="slack" title="slack" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/cli/discord"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="discord" title="discord" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/cli/himalaya"><img src="../assets/icons/himalaya.png" width="20" height="20" alt="himalaya" title="himalaya" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **工作與資料** | <a href="https://docs.mirage.strukto.ai/home/setup/cli/linear"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="linear" title="linear" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/cli/ntn"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="ntn" title="ntn" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/cli/trello"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="trello" title="trello" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/cli/airtable"><img src="https://cdn.simpleicons.org/airtable" width="20" height="20" alt="airtable" title="airtable" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/cli/gws"><img src="https://cdn.simpleicons.org/google" width="20" height="20" alt="gws" title="gws" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/cli/hf"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="hf" title="hf" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/cli/office"><img src="https://api.iconify.design/lucide/file-spreadsheet.svg?color=%23888888" width="20" height="20" alt="office" title="office" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/cli/pdftotext"><img src="https://api.iconify.design/lucide/file-text.svg?color=%23888888" width="20" height="20" alt="pdftotext" title="pdftotext" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/cli/pdfinfo"><img src="https://api.iconify.design/lucide/file-search.svg?color=%23888888" width="20" height="20" alt="pdfinfo" title="pdfinfo" /></a> |

## 虛擬機器

機器以同樣的方式虛擬化，而且不只針對程式語言。命令列上的任何命令都可以送到所設定的機器，例如 Python 可以藉助 [Monty](https://pydantic.dev/articles/pydantic-monty) 在行程內執行，而另一個命令（比如 `kubectl`）則透過 SSH 在遠端機器上執行。某一行由哪台機器處理，可以交給[腳本化的機器路由器](https://docs.mirage.strukto.ai/home/policy/route-machine)決定。

|                | 機器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**     | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/monty"><img src="https://cdn.simpleicons.org/pydantic" width="20" height="20" alt="Monty" title="Monty" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/runtime/wasi"><img src="https://cdn.simpleicons.org/webassembly" width="20" height="20" alt="WASI CPython on wasmtime" title="WASI CPython on wasmtime" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/runtime/pyodide"><img src="../assets/icons/pyodide.svg" width="56" height="20" alt="Pyodide" title="Pyodide" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/machine/host"><img src="../docs/images/sandlock-logo.svg" width="20" height="20" alt="sandlock" title="sandlock" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/machine/host"><img src="https://cdn.simpleicons.org/python" width="20" height="20" alt="Host CPython" title="Host CPython" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **JavaScript** | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="../assets/icons/quickjs.png" width="20" height="20" alt="QuickJS, serving node and js" title="QuickJS, serving node and js" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="https://cdn.simpleicons.org/javascript" width="20" height="20" alt="JavaScript" title="JavaScript" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="https://cdn.simpleicons.org/typescript" width="20" height="20" alt="TypeScript" title="TypeScript" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **機器**       | <a href="https://docs.mirage.strukto.ai/home/setup/machine/docker"><img src="https://cdn.simpleicons.org/docker" width="20" height="20" alt="Docker" title="Docker" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/machine/kubernetes"><img src="https://cdn.simpleicons.org/kubernetes" width="20" height="20" alt="Kubernetes" title="Kubernetes" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/machine/e2b"><img src="../docs/images/e2b-logo.svg" width="20" height="20" alt="E2B" title="E2B" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/machine/daytona"><img src="../docs/images/daytona-logo.svg" width="20" height="20" alt="Daytona" title="Daytona" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/machine/cloudflare_container"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare Container" title="Cloudflare Container" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/machine/boxd"><img src="../docs/images/boxd-logo.svg" width="20" height="20" alt="boxd" title="boxd" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/machine/smolvm"><img src="../docs/images/smolvm-logo.svg" width="20" height="20" alt="smolVM" title="smolVM" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/machine/microsandbox"><img src="../docs/images/microsandbox-logo.svg" width="20" height="20" alt="Microsandbox" title="Microsandbox" /></a> <a href="https://docs.mirage.strukto.ai/home/setup/machine/apple_container"><img src="https://cdn.simpleicons.org/apple/000000/e6edf3" width="20" height="20" alt="Apple Container" title="Apple Container" /></a>  <a href="https://docs.mirage.strukto.ai/home/setup/machine/ssh"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a> |

## 安全

Profile 決定一個工作階段可以執行什麼、可以看到什麼。命令由可自訂的 `allow`、`ask` 和 `deny` 規則管控，路徑由 `hide` 和 `show` 管控，因此被隱藏的檔案不只是不可讀，而是在 Agent 看到的檔案系統中根本不存在。對於這些規則無法表達的情況，Profile 可以指定一個策略腳本，它在每條命令的關口執行，自行答覆 allow、deny 或 ask；但和所有規則一樣，它只能收緊權限，不能授予權限。此外，宿主程式還可以在[策略引擎](https://docs.mirage.strukto.ai/home/policy/policies)上註冊自己的策略，這是一個有序的策略堆疊，工作區會在每條命令、每次 VFS 操作和工作階段寫入時查詢它。參見[策略文件](https://docs.mirage.strukto.ai/home/policy/overview)。

## 服務憑證

服務憑證可以對接密鑰已經存放的位置，包括 AWS Secrets Manager、1Password 和 dotenv，因此 Mirage 中的環境變數可以直接解析為其中某處保存的憑證。

|          | 來源                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **內建** | <a href="https://docs.mirage.strukto.ai/home/service-credentials#sources"><img src="../assets/icons/terminal.svg" width="20" height="20" alt="Environment" title="Environment" /></a> <a href="https://docs.mirage.strukto.ai/home/service-credentials#sources"><img src="https://cdn.simpleicons.org/dotenv" width="20" height="20" alt="dotenv" title="dotenv" /></a>                                                                    |
| **自訂** | <a href="https://docs.mirage.strukto.ai/home/service-credentials/1password"><img src="https://cdn.simpleicons.org/1password" width="20" height="20" alt="1Password" title="1Password" /></a> <a href="https://docs.mirage.strukto.ai/home/service-credentials/aws-secrets-manager"><img src="https://api.iconify.design/logos/aws-secrets-manager.svg" width="20" height="20" alt="AWS Secrets Manager" title="AWS Secrets Manager" /></a> |

## 安裝

- **Python** ≥ 3.12，用於 `mirage-ai` 套件和 `mirage` CLI
- **Node.js** Node 22 需 22.20+，Node 24 需 24.12+，或 25+，用於 TypeScript SDK

### Python

```bash
uv add mirage-ai              # 安裝 `mirage` 函式庫和 `mirage` CLI 執行檔
uv add 'mirage-ai[openai]'    # OpenAI Agents 介接器；每個 agent 框架是一個 extra
uv add 'mirage-ai[monty]'     # Monty：範例所用的行程內 Python 執行環境
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js 伺服器和 CLI
npm install @struktoai/mirage-browser   # 瀏覽器 / edge 執行環境
```

兩個執行環境套件都會自動引入 `@struktoai/mirage-core`。

### CLI

```bash
npm install -g @struktoai/mirage-cli
# 或
uvx --from mirage-ai mirage
# 或
npx @struktoai/mirage-cli
```

快速上手請參閱 [Python](https://docs.mirage.strukto.ai/python/quickstart)、[TypeScript](https://docs.mirage.strukto.ai/typescript/quickstart) 和 [CLI](https://docs.mirage.strukto.ai/home/access/cli) 的快速入門指南。

## 可腳本化的策略

對於規則無法表達的情況，Profile 可以指定策略腳本。腳本的 `pre_command` 接收命令，可以開啟命令中指定的檔案，並回傳 deny、ask 或 `None`。下面這個腳本停用 `rm`，以及程式碼會刪除檔案的 Python 腳本：

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

在 Profile 中註冊它，這裡讓它在每條命令之前於 Monty 上執行：

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

腳本還能在哪些其他階段作答，參見[策略腳本](https://docs.mirage.strukto.ai/home/policy/scripts)。

## 範例

- **[In-Process Terminal](https://docs.mirage.strukto.ai/home/examples/in-process-terminal).** 在你的應用程式中為 Agent 提供終端機，即使在 FastAPI 或 Express 伺服器裡也行，無需固定的機器或沙箱。
- **[Multi-machine Terminal](https://docs.mirage.strukto.ai/home/examples/multi-machine-terminal).** 橫跨不同機器的統一虛擬終端機，把每個任務放到適合它的機器上執行，讓 AI Agent 更有效率、更低成本地完成任務。
- **[Secured Terminal](https://docs.mirage.strukto.ai/home/examples/secured-terminal).** 在一份工作區設定中決定 Agent 能看到哪些檔案、能執行哪些命令和 CLI，以及它的工具使用哪些憑證。
- **[Infra-agnostic Terminal](https://docs.mirage.strukto.ai/home/examples/infra-agnostic-terminal).** 不綁定任何固定基礎設施的虛擬終端機，把檔案、工作階段和命令日誌放在既有的後端上。

## 貢獻者

感謝所有為 Mirage 做出貢獻的人。

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage 貢獻者" />
</a>
