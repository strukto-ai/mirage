<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage: terminal ảo cho AI Agent" width="900">
  </picture>
</p>

<p align="center">
  <a href="https://agentvfs.org">
    <picture>
      <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-narrow-dark.svg">
      <source media="(max-width: 767px)" srcset="../assets/agentvfs-banner-narrow-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-dark.svg">
      <img src="../assets/agentvfs-banner-light.svg" width="900" alt="AgentVFS: giao diện hệ thống tệp ảo mở, trung lập với nhà cung cấp, dành cho AI Agent" />
    </picture>
  </a>
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Tài liệu">
        <img src="https://img.shields.io/badge/mirage-t%C3%A0i%20li%E1%BB%87u-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="Trang web">
        <img src="https://img.shields.io/badge/t%E1%BA%A1o%20b%E1%BB%9Fi-strukto.ai-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="Giấy phép">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=gi%E1%BA%A5y%20ph%C3%A9p&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://doi.org/10.5281/zenodo.23504502" alt="DOI">
        <img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.23504502-0C0C0C?labelColor=FAFAFA" alt="DOI 10.5281/zenodo.23504502" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Cộng đồng Discord">
        <img src="https://img.shields.io/badge/discord-tham%20gia-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <a href="../assets/wechat-qr-code.jpg" aria-label="Cộng đồng WeChat">
        <img src="https://img.shields.io/badge/wechat-tham%20gia-0C0C0C?labelColor=FAFAFA&logo=wechat&logoColor=0C0C0C" alt="Cộng đồng WeChat" /></a>
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
  <a href="./README.de.md"><img alt="README auf Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="./README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage là **terminal ảo cho AI Agent**: một shell duy nhất phủ lên dữ liệu, CLI và runtime. Các công cụ Unix tiếp cận mọi dịch vụ, và `grep` chạy trên chức năng tìm kiếm riêng của từng dịch vụ, như của Gmail hay Slack. Mirage định tuyến mỗi lệnh tới runtime phù hợp với nó, nên phần lớn các dòng lệnh chạy trong tiến trình và chỉ công việc nặng mới tới sandbox, giúp giảm chi phí hạ tầng và token. Bản thân terminal rất nhẹ: một workspace chiếm **khoảng 100 KB** bộ nhớ và mỗi session mới **khoảng 10 KB**, nên một tiến trình phục vụ nhiều agent cùng lúc. Profile quyết định agent được chạy gì và thậm chí được thấy gì, còn các chính sách viết bằng script từ chối mọi thứ mà các quy tắc đó không diễn đạt được.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Kiến trúc Mirage: agent và harness tiếp cận profile và Mirage shell, hai thành phần này phân giải các lệnh kiểu Unix, CLI ảo và ngôn ngữ lập trình xuống máy, runtime và hệ thống tệp ảo, cùng với thông tin xác thực dịch vụ, công cụ chính sách và thông báo bên cạnh" width="100%">
  </picture>
</p>

Dưới đây là ví dụ khởi chạy Mirage bên trong một ứng dụng:

```python
ws = Workspace(
    {
        "/s3":    (S3VFS(S3Config(bucket="my-bucket")), MountMode.WRITE),
        "/slack": (SlackVFS(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
        "/gmail": (GmailVFS(GmailConfig(**google_credentials)), MountMode.READ),
    },
    # cài CLI Slack, chạy theo tên và được `man`, `which` liệt kê như mọi chương trình
    clis={"slack": (SLACK, {"token": slack_bot_token})},
    # profile analyst ẩn /s3/secrets và cấm đăng lên Slack cũng như curl
    profiles={
        "analyst": {
            "paths": {"hide": ["/s3/secrets"]},
            "commands": {"deny": ["slack send-message", "curl"]},
        },
    },
    # python chạy trên monty trong một worker, hoặc trong sandbox e2b
    machines={
        "py": {"provider": "worker"},
        "box": {"provider": "e2b", "sandbox_id": sandbox_id, "mount_type": "ssh", "captures": ["python", "python3"]},
    },
    # định tuyến phần tính toán: dòng có numpy chạy trên máy, phần còn lại trên monty
    route_policy=lambda ctx: "box" if "numpy" in ctx.line else None,
)

# thêm một agent dùng profile analyst
alice = await ws.session("alice", profile="analyst")

# một lệnh grep quét S3, Slack và Gmail, dùng tìm kiếm riêng của từng dịch vụ nếu có
await alice.shell("grep -rlw invoice /s3 /slack /gmail")

# chạy script nằm trong Slack trên monty, ghi báo cáo vào S3
await alice.shell("python3 /slack/channels/general__C0123/2026-10-21/files/report__F0456.py > /s3/report.txt")

# monty không có numpy, nên chính sách định tuyến gửi dòng này tới e2b
await alice.shell("python3 -c 'import numpy; print(numpy.arange(10).sum())'")
```

Và đây là những gì `alice` thấy trong shell:

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

## Giới thiệu

- **Một giao diện terminal ảo thống nhất, thay vì N SDK và M MCP.** Mọi backend đều dùng cùng một ngữ nghĩa hệ thống tệp, nên pipeline kết hợp được giữa các dịch vụ.
- **Hệ thống tệp ảo trên mọi nguồn dữ liệu.** S3, Google Drive, Slack, Gmail, Redis và các nguồn khác được gắn cạnh nhau dưới một gốc duy nhất, nên agent tiếp cận tất cả qua một giao diện thống nhất bằng các công cụ unix nó đã biết như `ls`, `grep`, `find` và `jq`.
- **Công cụ dòng lệnh ảo (CLI).** `git`, `slack` và `ntn` do chính Mirage đáp ứng, nên agent điều khiển dịch vụ mà không cần cài gì, xuyên qua các runtime và máy khác nhau; một công cụ còn có thể ảo hóa thành hai hoặc nhiều hơn, mỗi cái mang tên riêng với thông tin xác thực riêng.
- **Runtime động, có định tuyến.** Python, JavaScript và bất kỳ lệnh nào khác đều có thể được gửi tới runtime đã cấu hình, trong tiến trình, trong sandbox hoặc từ xa, tách tính toán khỏi lưu trữ và cho phép đổi bên này mà không động tới bên kia.
- **Mirage shell ảo hóa.** Nó gắn hệ thống tệp, các CLI và các runtime vào cùng một dòng lệnh, nên pipe, chuyển hướng, biến, job và lịch sử đều hoạt động xuyên cả ba.
- **Nhẹ ngay từ thiết kế.** Một workspace, tức chính terminal ảo, chiếm khoảng 100 KB bộ nhớ và mỗi session mới khoảng 10 KB, nên một tiến trình phục vụ nhiều agent mà không cần container hay VM cho từng agent.
- **Profile thiết kế cho agent.** `allow`, `ask` và `deny` chi phối lệnh và CLI, còn `hide` và `show` chi phối tệp và thư mục, nên một đường dẫn bị ẩn không chỉ là không đọc được mà còn không tồn tại trong hệ thống tệp mà agent nhìn thấy.
- **Công cụ chính sách viết được bằng script.** Một script chính sách có thể chặn mọi hành động nguy hiểm trước khi nó chạy, và cùng ngăn xếp đó kiểm soát mọi thao tác VFS và mọi lần ghi session, nên không tệp nào và không biến môi trường nào bị rò rỉ.
- **Thông báo nối vào VFS và agent.** Thay đổi bên ngoài trở thành luồng sự kiện trên mount, nên một trả lời Slack mới hiện ra như một thay đổi của tệp hội thoại trong hệ thống tệp ảo, và agent phản ứng theo đó thay vì quét lại toàn bộ cây.

## Hệ thống tệp ảo

[Mirage](https://www.strukto.ai/mirage) "mount" mọi thứ thành một hệ thống tệp ảo thống nhất cho AI agent. Mỗi dịch vụ nằm cạnh nhau dưới một gốc duy nhất và tuân theo cùng ngữ nghĩa POSIX.

|                                       | VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lưu trữ đối tượng**                 | <a href="https://aws.amazon.com/s3/"><img src="https://api.iconify.design/logos/aws-s3.svg" width="20" height="20" alt="Amazon S3" title="Amazon S3" /></a>  <a href="https://developers.cloudflare.com/r2/"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare R2" title="Cloudflare R2" /></a>  <a href="https://cloud.google.com/storage"><img src="https://api.iconify.design/logos/google-cloud.svg" width="25" height="20" alt="Google Cloud Storage" title="Google Cloud Storage" /></a>  <a href="https://www.oracle.com/cloud/storage/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/oracle.svg" width="32" height="20" alt="Oracle OCI" title="Oracle OCI" /></a>  <a href="https://supabase.com/storage"><img src="https://api.iconify.design/logos/supabase-icon.svg" width="19" height="20" alt="Supabase Storage" title="Supabase Storage" /></a>  <a href="https://min.io"><img src="https://cdn.simpleicons.org/minio" width="20" height="20" alt="MinIO" title="MinIO" /></a>  <a href="https://ceph.io/en/discover/technology/"><img src="https://cdn.simpleicons.org/ceph" width="20" height="20" alt="Ceph" title="Ceph" /></a>  <a href="https://github.com/seaweedfs/seaweedfs"><img src="../assets/icons/seaweedfs.svg" width="20" height="20" alt="SeaweedFS" title="SeaweedFS" /></a>  <a href="https://wasabi.com/cloud-object-storage"><img src="https://cdn.simpleicons.org/wasabi" width="20" height="20" alt="Wasabi" title="Wasabi" /></a>  <a href="https://www.backblaze.com/cloud-storage"><img src="https://cdn.simpleicons.org/backblaze" width="20" height="20" alt="Backblaze B2" title="Backblaze B2" /></a>  <a href="https://www.digitalocean.com/products/spaces"><img src="https://cdn.simpleicons.org/digitalocean" width="20" height="20" alt="DigitalOcean Spaces" title="DigitalOcean Spaces" /></a>  <a href="https://www.alibabacloud.com/product/oss"><img src="https://cdn.simpleicons.org/alibabacloud" width="20" height="20" alt="Alibaba Cloud OSS" title="Alibaba Cloud OSS" /></a>  <a href="https://www.tencentcloud.com/products/cos"><img src="../assets/icons/tencent.png" width="20" height="20" alt="Tencent Cloud COS" title="Tencent Cloud COS" /></a>  <a href="https://www.scaleway.com/en/object-storage/"><img src="https://cdn.simpleicons.org/scaleway" width="20" height="20" alt="Scaleway" title="Scaleway" /></a>  <a href="https://www.qingcloud.com/products/qingstor"><img src="../assets/icons/qingstor.png" width="20" height="20" alt="QingStor" title="QingStor" /></a>  <a href="https://huggingface.co/docs/hub/storage-buckets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Buckets" title="Hugging Face Buckets" /></a>  <a href="https://www.mongodb.com/docs/manual/core/gridfs/"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="GridFS" title="GridFS" /></a> |
| **Tệp và tài liệu**                   | <a href="https://workspace.google.com/products/drive/"><img src="https://cdn.simpleicons.org/googledrive" width="20" height="20" alt="Google Drive" title="Google Drive" /></a>  <a href="https://docs.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-docs.svg" width="14" height="20" alt="Google Docs" title="Google Docs" /></a>  <a href="https://sheets.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-sheets.svg" width="15" height="20" alt="Google Sheets" title="Google Sheets" /></a>  <a href="https://slides.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-slides.svg" width="15" height="20" alt="Google Slides" title="Google Slides" /></a>  <a href="https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-onedrive.svg" width="30" height="20" alt="OneDrive" title="OneDrive" /></a>  <a href="https://www.microsoft.com/microsoft-365/sharepoint/collaboration"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-sharepoint.svg" width="20" height="20" alt="SharePoint" title="SharePoint" /></a>  <a href="https://www.box.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/box.svg" width="20" height="20" alt="Box" title="Box" /></a>  <a href="https://www.dropbox.com"><img src="https://cdn.simpleicons.org/dropbox" width="20" height="20" alt="Dropbox" title="Dropbox" /></a>  <a href="https://nextcloud.com/files/"><img src="https://cdn.simpleicons.org/nextcloud" width="20" height="20" alt="Nextcloud" title="Nextcloud" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Nhắn tin và công việc**             | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="Slack" title="Slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="Discord" title="Discord" /></a>  <a href="https://mail.google.com"><img src="https://cdn.simpleicons.org/gmail" width="20" height="20" alt="Gmail" title="Gmail" /></a>  <a href="https://en.wikipedia.org/wiki/Internet_Message_Access_Protocol"><img src="https://api.iconify.design/lucide/mail.svg?color=%23888888" width="20" height="20" alt="IMAP / SMTP email" title="IMAP / SMTP email" /></a>  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="GitHub" title="GitHub" /></a>  <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="Linear" title="Linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="Notion" title="Notion" /></a>  <a href="https://trello.com"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="Trello" title="Trello" /></a>  <a href="https://workspace.google.com/products/calendar/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-calendar.svg" width="20" height="20" alt="Google Calendar" title="Google Calendar" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Cơ sở dữ liệu và nền tảng dữ liệu** | <a href="https://www.postgresql.org"><img src="https://cdn.simpleicons.org/postgresql" width="20" height="20" alt="PostgreSQL" title="PostgreSQL" /></a>  <a href="https://www.mongodb.com"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="MongoDB" title="MongoDB" /></a>  <a href="https://redis.io"><img src="https://cdn.simpleicons.org/redis" width="20" height="20" alt="Redis" title="Redis" /></a> <a href="https://upstash.com"><img src="https://cdn.simpleicons.org/upstash" width="20" height="20" alt="Upstash Redis" title="Upstash Redis" /></a>  <a href="https://lancedb.com"><img src="../assets/icons/lancedb.png" width="20" height="20" alt="LanceDB" title="LanceDB" /></a>  <a href="https://qdrant.tech"><img src="https://cdn.simpleicons.org/qdrant" width="20" height="20" alt="Qdrant" title="Qdrant" /></a>  <a href="https://www.trychroma.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/chroma.svg" width="31" height="20" alt="Chroma" title="Chroma" /></a>  <a href="https://mem0.ai"><img src="../docs/images/mem0.svg" width="20" height="20" alt="Mem0" title="Mem0" /></a>  <a href="https://huggingface.co/datasets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Datasets" title="Hugging Face Datasets" /></a>  <a href="https://huggingface.co/models"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Models" title="Hugging Face Models" /></a>  <a href="https://huggingface.co/spaces"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Spaces" title="Hugging Face Spaces" /></a>  <a href="https://docs.databricks.com/aws/en/volumes/"><img src="https://cdn.simpleicons.org/databricks" width="20" height="20" alt="Databricks Volumes" title="Databricks Volumes" /></a>  <a href="https://dify.ai"><img src="https://cdn.simpleicons.org/dify" width="20" height="20" alt="Dify" title="Dify" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Khả năng quan sát**                 | <a href="https://langfuse.com"><img src="../docs/images/langfuse-logo.svg" width="20" height="20" alt="Langfuse" title="Langfuse" /></a>  <a href="https://www.jaegertracing.io"><img src="https://cdn.simpleicons.org/jaeger" width="20" height="20" alt="Jaeger" title="Jaeger" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Cục bộ và từ xa**                   | <a href="https://en.wikipedia.org/wiki/Random-access_memory"><img src="https://api.iconify.design/lucide/memory-stick.svg?color=%23888888" width="20" height="20" alt="RAM" title="RAM" /></a>  <a href="https://en.wikipedia.org/wiki/File_system"><img src="https://api.iconify.design/lucide/hard-drive.svg?color=%23888888" width="20" height="20" alt="Disk" title="Disk" /></a>  <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system"><img src="https://api.iconify.design/lucide/folder-lock.svg?color=%23888888" width="20" height="20" alt="OPFS" title="OPFS" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Agent tiếp cận nó qua SDK Python và TypeScript, CLI `mirage`, hoặc một mountpoint thật qua FUSE và FSKit, rồi làm việc bằng các công cụ unix đã quen như `ls`, `grep`, `find` và `jq`.

## Công cụ dòng lệnh ảo

Các công cụ dòng lệnh này được ảo hóa: [Mirage](https://www.strukto.ai/mirage) tự đáp ứng `git`, `slack` hay `ntn`, nên agent điều khiển dịch vụ mà máy không cần cài chương trình đó. Mỗi công cụ mô phỏng công cụ thật, nên agent đã biết CLI không cần học gì mới. Vì là ảo, cùng một công cụ có thể được cài nhiều lần dưới các tên khác nhau, mỗi bản có thông tin xác thực riêng, nên mỗi agent nhận đúng những tài khoản được giao.

|                          | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mã nguồn**             | <a href="https://git-scm.com"><img src="https://cdn.simpleicons.org/git" width="20" height="20" alt="git" title="git" /></a>  <a href="https://cli.github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="gh" title="gh" /></a>                                                                                                                                                                                                                                                                                           |
| **Giao tiếp**            | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="slack" title="slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="discord" title="discord" /></a>  <a href="https://github.com/pimalaya/himalaya"><img src="../assets/icons/himalaya.png" width="20" height="20" alt="himalaya" title="himalaya" /></a>                                                                                                                         |
| **Công việc và dữ liệu** | <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="linear" title="linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="ntn" title="ntn" /></a>  <a href="https://workspace.google.com"><img src="https://cdn.simpleicons.org/google" width="20" height="20" alt="gws" title="gws" /></a>  <a href="https://huggingface.co"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="hf" title="hf" /></a> |

## Runtime ảo

Runtime được ảo hóa theo cùng cách, và không chỉ cho ngôn ngữ lập trình. Bất kỳ lệnh nào trên dòng đều có thể được chuyển hướng tới một runtime đã cấu hình, nên Python có thể chạy trong tiến trình với [Monty](https://pydantic.dev/articles/pydantic-monty) trong khi một lệnh khác, chẳng hạn `kubectl`, được gửi tới máy từ xa qua SSH. Runtime nào phục vụ một dòng lệnh có thể do một [bộ định tuyến runtime viết bằng script](https://docs.mirage.strukto.ai/home/policy/route-machine) quyết định.

|                | Runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**     | <a href="https://pydantic.dev/articles/pydantic-monty"><img src="https://cdn.simpleicons.org/pydantic" width="20" height="20" alt="Monty" title="Monty" /></a>  <a href="https://wasi.dev"><img src="https://cdn.simpleicons.org/webassembly" width="20" height="20" alt="WASI CPython on wasmtime" title="WASI CPython on wasmtime" /></a>  <a href="https://pyodide.org"><img src="../assets/icons/pyodide.svg" width="56" height="20" alt="Pyodide" title="Pyodide" /></a>  <a href="https://pypi.org/project/sandlock/"><img src="../docs/images/sandlock-logo.svg" width="20" height="20" alt="sandlock" title="sandlock" /></a>  <a href="https://www.python.org"><img src="https://cdn.simpleicons.org/python" width="20" height="20" alt="Host CPython" title="Host CPython" /></a>                                                                                                                                                                                                                                                   |
| **JavaScript** | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="../assets/icons/quickjs.png" width="20" height="20" alt="QuickJS, serving node and js" title="QuickJS, serving node and js" /></a> <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><img src="https://cdn.simpleicons.org/javascript" width="20" height="20" alt="JavaScript" title="JavaScript" /></a> <a href="https://www.typescriptlang.org"><img src="https://cdn.simpleicons.org/typescript" width="20" height="20" alt="TypeScript" title="TypeScript" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Máy**        | <a href="https://www.docker.com"><img src="https://cdn.simpleicons.org/docker" width="20" height="20" alt="Docker" title="Docker" /></a>  <a href="https://e2b.dev"><img src="../docs/images/e2b-logo.svg" width="20" height="20" alt="E2B" title="E2B" /></a>  <a href="https://www.daytona.io"><img src="../docs/images/daytona-logo.svg" width="20" height="20" alt="Daytona" title="Daytona" /></a>  <a href="https://smolmachines.com"><img src="../docs/images/smolvm-logo.svg" width="20" height="20" alt="smolVM" title="smolVM" /></a> <a href="https://microsandbox.dev"><img src="../docs/images/microsandbox-logo.svg" width="20" height="20" alt="Microsandbox" title="Microsandbox" /></a> <a href="https://github.com/apple/container"><img src="https://cdn.simpleicons.org/apple/000000/e6edf3" width="20" height="20" alt="Apple Container" title="Apple Container" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a> |

## Bảo mật

Profile quyết định một session được chạy gì và được thấy gì. Lệnh được chi phối bởi các quy tắc `allow`, `ask` và `deny` tùy chỉnh được, còn đường dẫn bởi `hide` và `show`, nên một tệp bị ẩn không chỉ là không đọc được mà còn không tồn tại trong hệ thống tệp mà agent thấy. Với những gì các quy tắc đó không diễn đạt được, profile có thể chỉ định một script chính sách chạy ở cổng kiểm soát của mọi lệnh và tự trả lời allow, deny hoặc ask, dù như mọi quy tắc khác nó chỉ có thể hạn chế chứ không bao giờ cấp quyền. Ngoài ra, ứng dụng chủ có thể đăng ký chính sách riêng trên [công cụ chính sách](https://docs.mirage.strukto.ai/home/policy/policies), một ngăn xếp có thứ tự mà workspace tham khảo ở mọi lệnh, mọi thao tác VFS và mọi lần ghi session. Xem [tài liệu chính sách](https://docs.mirage.strukto.ai/home/policy/overview).

## Thông tin xác thực dịch vụ

Thông tin xác thực dịch vụ tích hợp với những kho đang chứa secret, gồm AWS Secrets Manager, 1Password và dotenv, nên một biến môi trường trong Mirage có thể phân giải thẳng tới thông tin xác thực lưu ở một trong số đó.

|                  | Nguồn                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tích hợp sẵn** | <a href="https://en.wikipedia.org/wiki/Environment_variable"><img src="../assets/icons/terminal.svg" width="20" height="20" alt="Environment" title="Environment" /></a> <a href="https://www.dotenv.org"><img src="https://cdn.simpleicons.org/dotenv" width="20" height="20" alt="dotenv" title="dotenv" /></a>                                          |
| **Tùy chỉnh**    | <a href="https://1password.com"><img src="https://cdn.simpleicons.org/1password" width="20" height="20" alt="1Password" title="1Password" /></a> <a href="https://aws.amazon.com/secrets-manager/"><img src="https://api.iconify.design/logos/aws-secrets-manager.svg" width="20" height="20" alt="AWS Secrets Manager" title="AWS Secrets Manager" /></a> |

## Cài đặt

- **Python** ≥ 3.12 cho gói `mirage-ai` và CLI `mirage`
- **Node.js** 22.20+ trên Node 22, 24.12+ trên Node 24, hoặc 25+ cho SDK TypeScript

### Python

```bash
uv add mirage-ai              # cài thư viện `mirage` và binary CLI `mirage`
uv add 'mirage-ai[openai]'    # adapter OpenAI Agents; mỗi framework agent là một extra
uv add 'mirage-ai[monty]'     # Monty, runtime Python trong tiến trình mà các ví dụ dùng
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # máy chủ Node.js và CLI
npm install @struktoai/mirage-browser   # trình duyệt / edge runtime
npm install @struktoai/mirage-vercel    # adapter Vercel AI; mỗi framework agent có package riêng
```

Cả hai gói runtime đều tự động kéo theo `@struktoai/mirage-core`.

### CLI

```bash
npm install -g @struktoai/mirage-cli
# hoặc
uvx --from mirage-ai mirage
# hoặc
npx @struktoai/mirage-cli
```

Để bắt đầu, xem hướng dẫn nhanh cho [Python](https://docs.mirage.strukto.ai/python/quickstart), [TypeScript](https://docs.mirage.strukto.ai/typescript/quickstart) và [CLI](https://docs.mirage.strukto.ai/home/access/cli).

## Chính sách viết bằng script

Profile có thể chỉ định script chính sách cho những gì quy tắc của nó không diễn đạt được. `pre_command` của script nhận lệnh, có thể mở các tệp mà lệnh nêu tên, và trả về deny, ask hoặc `None`. Script này vô hiệu hóa `rm`, và cả script Python có mã xóa tệp:

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

Đăng ký nó trong một profile, ở đây để chạy trên Monty trước mỗi lệnh:

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

Xem [script chính sách](https://docs.mirage.strukto.ai/home/policy/scripts) để biết các giai đoạn khác mà script có thể trả lời.

## Terminal nhúng

Phần lớn thời gian agent không cần sandbox, chỉ cần một giao diện giống terminal, và Mirage nhúng một giao diện như vậy vào máy chủ ứng dụng. Mỗi terminal là một session Mirage với thư mục làm việc, môi trường và lịch sử riêng, còn Python chạy trong tiến trình trên Monty, nên terminal khởi động mà không cần container hay VM. Dưới đây là bản Express; bản FastAPI có trong [tài liệu](https://docs.mirage.strukto.ai/home/examples/lightweight-terminal).

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

## Người đóng góp

Cảm ơn tất cả những người đã đóng góp cho Mirage.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Người đóng góp cho Mirage" />
</a>
