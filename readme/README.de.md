<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage: ein virtuelles Terminal für KI-Agenten" width="900">
  </picture>
</p>

<p align="center">
  <a href="https://agentvfs.org">
    <picture>
      <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-narrow-dark.svg">
      <source media="(max-width: 767px)" srcset="../assets/agentvfs-banner-narrow-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-dark.svg">
      <img src="../assets/agentvfs-banner-light.svg" width="900" alt="AgentVFS: die offene, herstellerneutrale Dateisystem-Schnittstelle für KI-Agenten" />
    </picture>
  </a>
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Dokumentation">
        <img src="https://img.shields.io/badge/mirage-dokumentation-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="Website">
        <img src="https://img.shields.io/badge/von-strukto.ai-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="Lizenz">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=lizenz&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://doi.org/10.5281/zenodo.23504502" alt="DOI">
        <img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.23504502-0C0C0C?labelColor=FAFAFA" alt="DOI 10.5281/zenodo.23504502" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord-Community">
        <img src="https://img.shields.io/badge/discord-beitreten-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <a href="../assets/wechat-qr-code.jpg" aria-label="WeChat-Community">
        <img src="https://img.shields.io/badge/wechat-beitreten-0C0C0C?labelColor=FAFAFA&logo=wechat&logoColor=0C0C0C" alt="WeChat-Community" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Python-Dokumentation">
        <img src="https://img.shields.io/badge/python-dokumentation-0C0C0C?labelColor=FAFAFA&logo=python&logoColor=0C0C0C" alt="Python-Dokumentation"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="PyPI-Version">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="TypeScript-Dokumentation">
        <img src="https://img.shields.io/badge/typescript-dokumentation-0C0C0C?labelColor=FAFAFA&logo=typescript&logoColor=0C0C0C" alt="TypeScript-Dokumentation"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-node" alt="NPM-Version">
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

Mirage ist **ein virtuelles Terminal für KI-Agenten**: eine Shell über Daten, CLIs und Laufzeitumgebungen. Unix-Werkzeuge erreichen jeden Dienst, und `grep` nutzt die eigene Suche des jeweiligen Dienstes, etwa die von Gmail oder Slack. Mirage leitet jeden Befehl an die passende Laufzeitumgebung weiter, sodass die meisten Zeilen im Prozess laufen und nur schwere Arbeit eine Sandbox erreicht, was Infrastrukturkosten und Tokens spart. Das Terminal selbst ist leicht: Ein Workspace belegt **etwa 100 KB** Speicher und jede neue Session **etwa 10 KB**, sodass ein Prozess viele Agenten zugleich bedient. Profile legen fest, was ein Agent ausführen und sogar was er sehen darf, und skriptfähige Policies lehnen alles ab, was diese Regeln nicht ausdrücken können.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage-Architektur: Agenten und Harness erreichen Profile und die Mirage-Shell, die Unix-artige Befehle, virtuelle CLIs und Programmiersprachen auf Maschinen, Laufzeitumgebungen und das virtuelle Dateisystem auflösen, mit Dienst-Zugangsdaten, Policy-Engine und Benachrichtigungen daneben" width="100%">
  </picture>
</p>

Hier ein Beispiel, wie Mirage in einer Anwendung gestartet wird:

```python
ws = Workspace(
    {
        "/s3":    (S3VFS(S3Config(bucket="my-bucket")), MountMode.WRITE),
        "/slack": (SlackVFS(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
        "/gmail": (GmailVFS(GmailConfig(**google_credentials)), MountMode.READ),
    },
    # installiert die Slack-CLI, per Name aufgerufen und wie jedes Programm von `man` und `which` gelistet
    clis={"slack": (SLACK, {"token": slack_bot_token})},
    # das Profil analyst verbirgt /s3/secrets und verbietet Posts in Slack sowie curl
    profiles={
        "analyst": {
            "paths": {"hide": ["/s3/secrets"]},
            "commands": {"deny": ["slack send-message", "curl"]},
        },
    },
    # Python läuft im Prozess auf monty oder in der e2b-Sandbox
    machines={
        "py": {"provider": "in_process", "runtime": "monty"},
        "box": {"provider": "e2b", "sandbox_id": sandbox_id, "mount_type": "ssh", "captures": ["python", "python3"]},
    },
    # leitet die Berechnung: numpy-Zeilen laufen auf der Maschine, der Rest auf monty
    route_policy=lambda ctx: "box" if "numpy" in ctx.line else None,
)

# fügt einen Agenten mit dem Profil analyst hinzu
alice = await ws.session("alice", profile="analyst")

# ein grep durchsucht S3, Slack und Gmail, mit der eigenen Suche jedes Dienstes, wo es eine gibt
await alice.shell("grep -rlw invoice /s3 /slack /gmail")

# führt ein Skript aus Slack auf monty aus und legt den Bericht in S3 ab
await alice.shell("python3 /slack/channels/general__C0123/2026-10-21/files/report__F0456.py > /s3/report.txt")

# numpy fehlt in monty, also schickt die Routing-Policy diese Zeile an e2b
await alice.shell("python3 -c 'import numpy; print(numpy.arange(10).sum())'")
```

Und das sieht `alice` in der Shell:

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

## Überblick

- **Eine einheitliche virtuelle Terminal-Schnittstelle statt N SDKs und M MCPs.** Jedes Backend spricht dieselbe Dateisystem-Semantik, sodass sich Pipelines über Dienste hinweg zusammensetzen lassen.
- **Ein virtuelles Dateisystem über alle Quellen.** S3, Google Drive, Slack, Gmail, Redis und die übrigen werden nebeneinander unter einer einzigen Wurzel eingehängt, sodass ein Agent sie alle über eine einheitliche Schnittstelle erreicht, mit den Unix-Werkzeugen, die er ohnehin kennt, etwa `ls`, `grep`, `find` und `jq`.
- **Virtuelle Kommandozeilenwerkzeuge (CLIs).** `git`, `slack` und `ntn` beantwortet Mirage selbst, sodass ein Agent den Dienst ohne jede Installation bedient, über verschiedene Laufzeitumgebungen und Maschinen hinweg; ein Werkzeug lässt sich zudem in zwei oder mehr virtualisieren, jedes unter eigenem Namen mit eigenen Zugangsdaten.
- **Geroutete, dynamische Laufzeitumgebungen.** Python, JavaScript und jeder andere Befehl kann an eine konfigurierte Laufzeitumgebung geschickt werden, im Prozess, in einer Sandbox oder entfernt, was Berechnung von Speicher entkoppelt und beide unabhängig voneinander austauschbar macht.
- **Die virtualisierte Mirage-Shell.** Sie verbindet Dateisystem, CLIs und Laufzeitumgebungen zu einer einzigen Kommandozeile, sodass Pipes, Umleitungen, Variablen, Jobs und History über alle drei hinweg funktionieren.
- **Von Grund auf leichtgewichtig.** Ein Workspace, das virtuelle Terminal selbst, belegt etwa 100 KB Speicher und jede neue Session etwa 10 KB, sodass ein Prozess viele Agenten bedient, ohne Container oder VM pro Agent.
- **Profile, die für Agenten entworfen sind.** `allow`, `ask` und `deny` steuern Befehle und CLIs, `hide` und `show` steuern Dateien und Ordner, sodass ein verborgener Pfad nicht bloß unlesbar ist, sondern in dem Dateisystem, das der Agent sieht, gar nicht existiert.
- **Eine skriptfähige Policy-Engine.** Ein Policy-Skript kann jede gefährliche Aktion verhindern, bevor sie ausgeführt wird, und derselbe Stapel prüft jede VFS-Operation und jeden Session-Schreibzugriff, sodass weder eine Datei noch eine Umgebungsvariable nach außen dringt.
- **Benachrichtigungen, die mit dem VFS und den Agenten verdrahtet sind.** Externe Änderungen werden zu einem Ereignisstrom auf dem Mount, sodass eine neue Slack-Antwort als Änderung der Chat-Datei im virtuellen Dateisystem erscheint und der Agent darauf reagiert, statt den Baum erneut zu durchsuchen.

## Virtuelles Dateisystem

[Mirage](https://www.strukto.ai/mirage) „mountet“ alles als ein einheitliches virtuelles Dateisystem für KI-Agenten. Jeder Dienst liegt nebeneinander unter einer einzigen Wurzel und folgt derselben POSIX-Semantik.

|                                      | VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objektspeicher**                   | <a href="https://aws.amazon.com/s3/"><img src="https://api.iconify.design/logos/aws-s3.svg" width="20" height="20" alt="Amazon S3" title="Amazon S3" /></a>  <a href="https://developers.cloudflare.com/r2/"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare R2" title="Cloudflare R2" /></a>  <a href="https://cloud.google.com/storage"><img src="https://api.iconify.design/logos/google-cloud.svg" width="25" height="20" alt="Google Cloud Storage" title="Google Cloud Storage" /></a>  <a href="https://www.oracle.com/cloud/storage/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/oracle.svg" width="32" height="20" alt="Oracle OCI" title="Oracle OCI" /></a>  <a href="https://supabase.com/storage"><img src="https://api.iconify.design/logos/supabase-icon.svg" width="19" height="20" alt="Supabase Storage" title="Supabase Storage" /></a>  <a href="https://min.io"><img src="https://cdn.simpleicons.org/minio" width="20" height="20" alt="MinIO" title="MinIO" /></a>  <a href="https://ceph.io/en/discover/technology/"><img src="https://cdn.simpleicons.org/ceph" width="20" height="20" alt="Ceph" title="Ceph" /></a>  <a href="https://github.com/seaweedfs/seaweedfs"><img src="../assets/icons/seaweedfs.svg" width="20" height="20" alt="SeaweedFS" title="SeaweedFS" /></a>  <a href="https://wasabi.com/cloud-object-storage"><img src="https://cdn.simpleicons.org/wasabi" width="20" height="20" alt="Wasabi" title="Wasabi" /></a>  <a href="https://www.backblaze.com/cloud-storage"><img src="https://cdn.simpleicons.org/backblaze" width="20" height="20" alt="Backblaze B2" title="Backblaze B2" /></a>  <a href="https://www.digitalocean.com/products/spaces"><img src="https://cdn.simpleicons.org/digitalocean" width="20" height="20" alt="DigitalOcean Spaces" title="DigitalOcean Spaces" /></a>  <a href="https://www.alibabacloud.com/product/oss"><img src="https://cdn.simpleicons.org/alibabacloud" width="20" height="20" alt="Alibaba Cloud OSS" title="Alibaba Cloud OSS" /></a>  <a href="https://www.tencentcloud.com/products/cos"><img src="../assets/icons/tencent.png" width="20" height="20" alt="Tencent Cloud COS" title="Tencent Cloud COS" /></a>  <a href="https://www.scaleway.com/en/object-storage/"><img src="https://cdn.simpleicons.org/scaleway" width="20" height="20" alt="Scaleway" title="Scaleway" /></a>  <a href="https://www.qingcloud.com/products/qingstor"><img src="../assets/icons/qingstor.png" width="20" height="20" alt="QingStor" title="QingStor" /></a>  <a href="https://huggingface.co/docs/hub/storage-buckets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Buckets" title="Hugging Face Buckets" /></a>  <a href="https://www.mongodb.com/docs/manual/core/gridfs/"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="GridFS" title="GridFS" /></a> |
| **Dateien und Dokumente**            | <a href="https://workspace.google.com/products/drive/"><img src="https://cdn.simpleicons.org/googledrive" width="20" height="20" alt="Google Drive" title="Google Drive" /></a>  <a href="https://docs.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-docs.svg" width="14" height="20" alt="Google Docs" title="Google Docs" /></a>  <a href="https://sheets.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-sheets.svg" width="15" height="20" alt="Google Sheets" title="Google Sheets" /></a>  <a href="https://slides.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-slides.svg" width="15" height="20" alt="Google Slides" title="Google Slides" /></a>  <a href="https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-onedrive.svg" width="30" height="20" alt="OneDrive" title="OneDrive" /></a>  <a href="https://www.microsoft.com/microsoft-365/sharepoint/collaboration"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-sharepoint.svg" width="20" height="20" alt="SharePoint" title="SharePoint" /></a>  <a href="https://www.box.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/box.svg" width="20" height="20" alt="Box" title="Box" /></a>  <a href="https://www.dropbox.com"><img src="https://cdn.simpleicons.org/dropbox" width="20" height="20" alt="Dropbox" title="Dropbox" /></a>  <a href="https://nextcloud.com/files/"><img src="https://cdn.simpleicons.org/nextcloud" width="20" height="20" alt="Nextcloud" title="Nextcloud" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Messaging und Arbeit**             | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="Slack" title="Slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="Discord" title="Discord" /></a>  <a href="https://mail.google.com"><img src="https://cdn.simpleicons.org/gmail" width="20" height="20" alt="Gmail" title="Gmail" /></a>  <a href="https://en.wikipedia.org/wiki/Internet_Message_Access_Protocol"><img src="https://api.iconify.design/lucide/mail.svg?color=%23888888" width="20" height="20" alt="IMAP / SMTP email" title="IMAP / SMTP email" /></a>  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="GitHub" title="GitHub" /></a>  <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="Linear" title="Linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="Notion" title="Notion" /></a>  <a href="https://trello.com"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="Trello" title="Trello" /></a>  <a href="https://workspace.google.com/products/calendar/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-calendar.svg" width="20" height="20" alt="Google Calendar" title="Google Calendar" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Datenbanken und Datenplattformen** | <a href="https://www.postgresql.org"><img src="https://cdn.simpleicons.org/postgresql" width="20" height="20" alt="PostgreSQL" title="PostgreSQL" /></a>  <a href="https://www.mongodb.com"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="MongoDB" title="MongoDB" /></a>  <a href="https://redis.io"><img src="https://cdn.simpleicons.org/redis" width="20" height="20" alt="Redis" title="Redis" /></a> <a href="https://upstash.com"><img src="https://cdn.simpleicons.org/upstash" width="20" height="20" alt="Upstash Redis" title="Upstash Redis" /></a>  <a href="https://lancedb.com"><img src="../assets/icons/lancedb.png" width="20" height="20" alt="LanceDB" title="LanceDB" /></a>  <a href="https://qdrant.tech"><img src="https://cdn.simpleicons.org/qdrant" width="20" height="20" alt="Qdrant" title="Qdrant" /></a>  <a href="https://www.trychroma.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/chroma.svg" width="31" height="20" alt="Chroma" title="Chroma" /></a>  <a href="https://mem0.ai"><img src="../docs/images/mem0.svg" width="20" height="20" alt="Mem0" title="Mem0" /></a>  <a href="https://huggingface.co/datasets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Datasets" title="Hugging Face Datasets" /></a>  <a href="https://huggingface.co/models"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Models" title="Hugging Face Models" /></a>  <a href="https://huggingface.co/spaces"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Spaces" title="Hugging Face Spaces" /></a>  <a href="https://docs.databricks.com/aws/en/volumes/"><img src="https://cdn.simpleicons.org/databricks" width="20" height="20" alt="Databricks Volumes" title="Databricks Volumes" /></a>  <a href="https://dify.ai"><img src="https://cdn.simpleicons.org/dify" width="20" height="20" alt="Dify" title="Dify" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Observability**                    | <a href="https://langfuse.com"><img src="../docs/images/langfuse-logo.svg" width="20" height="20" alt="Langfuse" title="Langfuse" /></a>  <a href="https://www.jaegertracing.io"><img src="https://cdn.simpleicons.org/jaeger" width="20" height="20" alt="Jaeger" title="Jaeger" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Lokal und entfernt**               | <a href="https://en.wikipedia.org/wiki/Random-access_memory"><img src="https://api.iconify.design/lucide/memory-stick.svg?color=%23888888" width="20" height="20" alt="RAM" title="RAM" /></a>  <a href="https://en.wikipedia.org/wiki/File_system"><img src="https://api.iconify.design/lucide/hard-drive.svg?color=%23888888" width="20" height="20" alt="Disk" title="Disk" /></a>  <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system"><img src="https://api.iconify.design/lucide/folder-lock.svg?color=%23888888" width="20" height="20" alt="OPFS" title="OPFS" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Agenten erreichen es über die Python- und TypeScript-SDKs, die CLI `mirage` oder einen echten Mountpoint über FUSE und FSKit und bearbeiten es dann mit den Unix-Werkzeugen, die sie schon kennen, etwa `ls`, `grep`, `find` und `jq`.

## Virtuelle Kommandozeilenwerkzeuge

Diese Kommandozeilenwerkzeuge sind virtualisiert: [Mirage](https://www.strukto.ai/mirage) beantwortet `git`, `slack` oder `ntn` selbst, sodass ein Agent den Dienst bedient, ohne dass das Programm auf der Maschine installiert ist. Jedes ahmt das echte Werkzeug nach, ein Agent, der die CLI kennt, braucht also nichts Neues. Weil sie virtuell sind, lässt sich dasselbe Werkzeug mehrfach unter verschiedenen Namen installieren, jedes mit eigenen Zugangsdaten, sodass jeder Agent genau die Konten erhält, die ihm zugewiesen sind.

|                      | CLIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code**             | <a href="https://git-scm.com"><img src="https://cdn.simpleicons.org/git" width="20" height="20" alt="git" title="git" /></a>  <a href="https://cli.github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="gh" title="gh" /></a>                                                                                                                                                                                                                                                                                           |
| **Kommunikation**    | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="slack" title="slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="discord" title="discord" /></a>  <a href="https://github.com/pimalaya/himalaya"><img src="../assets/icons/himalaya.png" width="20" height="20" alt="himalaya" title="himalaya" /></a>                                                                                                                         |
| **Arbeit und Daten** | <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="linear" title="linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="ntn" title="ntn" /></a>  <a href="https://workspace.google.com"><img src="https://cdn.simpleicons.org/google" width="20" height="20" alt="gws" title="gws" /></a>  <a href="https://huggingface.co"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="hf" title="hf" /></a> |

## Virtuelle Laufzeitumgebung

Laufzeitumgebungen werden auf dieselbe Weise virtualisiert, und nicht nur für Programmiersprachen. Jeder Befehl auf der Zeile kann an eine konfigurierte Laufzeitumgebung umgeleitet werden: Python läuft etwa im Prozess mit [Monty](https://pydantic.dev/articles/pydantic-monty), während ein anderer Befehl, sagen wir `kubectl`, per SSH an eine entfernte Maschine geht. Welche Laufzeitumgebung eine Zeile bedient, kann ein [geskripteter Runtime-Router](https://docs.mirage.strukto.ai/home/policy/route-machine) entscheiden.

|                | Laufzeitumgebungen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**     | <a href="https://pydantic.dev/articles/pydantic-monty"><img src="https://cdn.simpleicons.org/pydantic" width="20" height="20" alt="Monty" title="Monty" /></a>  <a href="https://wasi.dev"><img src="https://cdn.simpleicons.org/webassembly" width="20" height="20" alt="WASI CPython on wasmtime" title="WASI CPython on wasmtime" /></a>  <a href="https://pyodide.org"><img src="../assets/icons/pyodide.svg" width="56" height="20" alt="Pyodide" title="Pyodide" /></a>  <a href="https://pypi.org/project/sandlock/"><img src="../docs/images/sandlock-logo.svg" width="20" height="20" alt="sandlock" title="sandlock" /></a>  <a href="https://www.python.org"><img src="https://cdn.simpleicons.org/python" width="20" height="20" alt="Host CPython" title="Host CPython" /></a>                                                                                                                                                                                                                                                   |
| **JavaScript** | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="../assets/icons/quickjs.png" width="20" height="20" alt="QuickJS, serving node and js" title="QuickJS, serving node and js" /></a> <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><img src="https://cdn.simpleicons.org/javascript" width="20" height="20" alt="JavaScript" title="JavaScript" /></a> <a href="https://www.typescriptlang.org"><img src="https://cdn.simpleicons.org/typescript" width="20" height="20" alt="TypeScript" title="TypeScript" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Maschinen**  | <a href="https://www.docker.com"><img src="https://cdn.simpleicons.org/docker" width="20" height="20" alt="Docker" title="Docker" /></a>  <a href="https://e2b.dev"><img src="../docs/images/e2b-logo.svg" width="20" height="20" alt="E2B" title="E2B" /></a>  <a href="https://www.daytona.io"><img src="../docs/images/daytona-logo.svg" width="20" height="20" alt="Daytona" title="Daytona" /></a>  <a href="https://smolmachines.com"><img src="../docs/images/smolvm-logo.svg" width="20" height="20" alt="smolVM" title="smolVM" /></a> <a href="https://microsandbox.dev"><img src="../docs/images/microsandbox-logo.svg" width="20" height="20" alt="Microsandbox" title="Microsandbox" /></a> <a href="https://github.com/apple/container"><img src="https://cdn.simpleicons.org/apple/000000/e6edf3" width="20" height="20" alt="Apple Container" title="Apple Container" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a> |

## Sicherheit

Ein Profil legt fest, was eine Session ausführen und was sie sehen darf. Befehle werden durch anpassbare `allow`-, `ask`- und `deny`-Regeln gesteuert, Pfade durch `hide` und `show`, sodass eine verborgene Datei nicht bloß unlesbar ist, sondern in dem Dateisystem, das der Agent sieht, gar nicht existiert. Für alles, was diese Regeln nicht ausdrücken können, kann ein Profil ein Policy-Skript benennen, das bei jedem Befehl an der Schranke läuft und selbst mit allow, deny oder ask antwortet; wie jede Regel kann es jedoch nur einschränken und nie gewähren. Unabhängig davon kann ein Host eigene Policies bei der [Policy-Engine](https://docs.mirage.strukto.ai/home/policy/policies) registrieren, einem geordneten Stapel, den der Workspace bei jedem Befehl, jeder VFS-Operation und jedem Session-Schreibzugriff befragt. Siehe die [Policy-Dokumentation](https://docs.mirage.strukto.ai/home/policy/overview).

## Dienst-Zugangsdaten

Dienst-Zugangsdaten binden die Speicher ein, in denen Secrets bereits liegen, darunter AWS Secrets Manager, 1Password und dotenv, sodass eine Umgebungsvariable in Mirage direkt zu Zugangsdaten aus einem davon aufgelöst werden kann.

|                       | Quellen                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integriert**        | <a href="https://en.wikipedia.org/wiki/Environment_variable"><img src="../assets/icons/terminal.svg" width="20" height="20" alt="Environment" title="Environment" /></a> <a href="https://www.dotenv.org"><img src="https://cdn.simpleicons.org/dotenv" width="20" height="20" alt="dotenv" title="dotenv" /></a>                                          |
| **Benutzerdefiniert** | <a href="https://1password.com"><img src="https://cdn.simpleicons.org/1password" width="20" height="20" alt="1Password" title="1Password" /></a> <a href="https://aws.amazon.com/secrets-manager/"><img src="https://api.iconify.design/logos/aws-secrets-manager.svg" width="20" height="20" alt="AWS Secrets Manager" title="AWS Secrets Manager" /></a> |

## Installation

- **Python** ≥ 3.12 für das Paket `mirage-ai` und die CLI `mirage`
- **Node.js** 22.20+ auf Node 22, 24.12+ auf Node 24 oder 25+ für das TypeScript-SDK

### Python

```bash
uv add mirage-ai              # installiert die Bibliothek `mirage` und die CLI `mirage`
uv add 'mirage-ai[openai]'    # OpenAI-Agents-Adapter; jedes Agent-Framework ist ein Extra
uv add 'mirage-ai[monty]'     # Monty, die In-Process-Python-Laufzeitumgebung der Beispiele
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js-Server und CLI
npm install @struktoai/mirage-browser   # Browser- und Edge-Laufzeitumgebungen
npm install @struktoai/mirage-vercel    # Vercel-AI-Adapter; jedes Agent-Framework hat ein eigenes Paket
```

Beide Runtime-Pakete installieren `@struktoai/mirage-core` automatisch mit.

### CLI

```bash
npm install -g @struktoai/mirage-cli
# oder
uvx --from mirage-ai mirage
# oder
npx @struktoai/mirage-cli
```

Zum Einstieg siehe die Schnellstarts für [Python](https://docs.mirage.strukto.ai/python/quickstart), [TypeScript](https://docs.mirage.strukto.ai/typescript/quickstart) und die [CLI](https://docs.mirage.strukto.ai/home/access/cli).

## Skriptfähige Policies

Ein Profil kann Policy-Skripte für das benennen, was seine Regeln nicht ausdrücken können. Das `pre_command` eines Skripts erhält den Befehl, kann die darin genannten Dateien öffnen und gibt ein deny, ein ask oder `None` zurück. Dieses hier sperrt `rm` sowie jedes Python-Skript, dessen Code Dateien löscht:

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

Registriere es in einem Profil, hier so, dass es vor jedem Befehl auf Monty läuft:

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

Die übrigen Stufen, an denen ein Skript antworten kann, beschreiben die [Policy-Skripte](https://docs.mirage.strukto.ai/home/policy/scripts).

## Eingebettetes Terminal

Meist braucht ein Agent keine Sandbox, sondern nur eine terminalartige Schnittstelle, und Mirage bettet eine in einen Anwendungsserver ein. Jedes Terminal ist eine Mirage-Session mit eigenem Arbeitsverzeichnis, eigener Umgebung und History, und Python läuft im Prozess auf Monty, sodass ein Terminal ohne Container oder VM startet. Hier mit Express; die FastAPI-Version steht in der [Dokumentation](https://docs.mirage.strukto.ai/home/examples/lightweight-terminal).

```bash
npm install @struktoai/mirage-node @pydantic/monty express
```

```ts
import express from 'express'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

const ws = new Workspace(
  { '/work': new RAMVFS() },
  { mode: MountMode.EXEC, machines: { py: { provider: 'in_process', runtime: 'monty' } } },
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

## Mitwirkende

Dank an alle, die zu Mirage beigetragen haben.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage-Mitwirkende" />
</a>
