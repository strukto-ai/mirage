<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage : un terminal virtuel pour les agents IA" width="900">
  </picture>
</p>

<p align="center">
  <a href="https://agentvfs.org">
    <picture>
      <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-narrow-dark.svg">
      <source media="(max-width: 767px)" srcset="../assets/agentvfs-banner-narrow-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/agentvfs-banner-dark.svg">
      <img src="../assets/agentvfs-banner-light.svg" width="900" alt="AgentVFS : l'interface de système de fichiers virtuel ouverte et neutre pour les agents IA" />
    </picture>
  </a>
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Documentation">
        <img src="https://img.shields.io/badge/mirage-documentation-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="Site web">
        <img src="https://img.shields.io/badge/par-strukto.ai-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="Licence">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=licence&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://doi.org/10.5281/zenodo.23504502" alt="DOI">
        <img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.23504502-0C0C0C?labelColor=FAFAFA" alt="DOI 10.5281/zenodo.23504502" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Communauté Discord">
        <img src="https://img.shields.io/badge/discord-rejoindre-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
    <a href="../assets/wechat-qr-code.jpg" aria-label="Communauté WeChat">
        <img src="https://img.shields.io/badge/wechat-rejoindre-0C0C0C?labelColor=FAFAFA&logo=wechat&logoColor=0C0C0C" alt="Communauté WeChat" /></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/python/quickstart" alt="Documentation Python">
        <img src="https://img.shields.io/badge/python-documentation-0C0C0C?labelColor=FAFAFA&logo=python&logoColor=0C0C0C" alt="Documentation Python"></a>
    <a href="https://pypi.org/project/mirage-ai/" alt="Version PyPI">
        <img src="https://img.shields.io/pypi/v/mirage-ai.svg?color=0C0C0C&labelColor=FAFAFA"/></a>
    <br/>
    <a href="https://docs.mirage.strukto.ai/typescript/quickstart" alt="Documentation TypeScript">
        <img src="https://img.shields.io/badge/typescript-documentation-0C0C0C?labelColor=FAFAFA&logo=typescript&logoColor=0C0C0C" alt="Documentation TypeScript"></a>
    <a href="https://www.npmjs.com/package/@struktoai/mirage-node" alt="Version NPM">
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

Mirage est **un terminal virtuel pour les agents IA** : un seul shell au-dessus des données, des CLI et des runtimes. Les outils Unix atteignent chaque service, et `grep` s'appuie sur la recherche propre à chaque service, comme celle de Gmail ou de Slack. Mirage route chaque commande vers le runtime qui lui convient, si bien que la plupart des lignes s'exécutent en processus et que seul le travail lourd atteint un bac à sable, ce qui réduit le coût d'infrastructure et les tokens. Le terminal lui-même est léger : un espace de travail occupe **environ 100 Ko** de mémoire et chaque nouvelle session **environ 10 Ko**, si bien qu'un seul processus sert de nombreux agents à la fois. Les profils décident de ce qu'un agent peut exécuter et même de ce qu'il peut voir, et des politiques scriptables refusent tout ce que ces règles ne peuvent exprimer.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Architecture Mirage : les agents et le harnais atteignent les profils et le shell Mirage, qui résolvent les commandes de type Unix, les CLI virtuelles et les langages de programmation vers les machines, les runtimes et le système de fichiers virtuel, avec l'authentification, le moteur de politiques et les notifications à côté" width="100%">
  </picture>
</p>

Voici un exemple de lancement de Mirage dans une application :

```python
ws = Workspace(
    {
        "/s3":    (S3VFS(S3Config(bucket="my-bucket")), MountMode.WRITE),
        "/slack": (SlackVFS(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
        "/gmail": (GmailVFS(GmailConfig(**google_credentials)), MountMode.READ),
    },
    # installe le CLI Slack, lancé par son nom et listé par `man` et `which` comme tout programme
    clis={"slack": (SLACK, {"token": slack_bot_token})},
    # le profil analyst masque /s3/secrets et interdit de publier sur Slack et curl
    profiles={
        "analyst": {
            "paths": {"hide": ["/s3/secrets"]},
            "commands": {"deny": ["slack send-message", "curl"]},
        },
    },
    # le bac à sable e2b est une machine ; le runtime remote y exécute les programmes
    machines={"box": {"provider": "e2b", "sandbox_id": sandbox_id, "mount_type": "ssh"}},
    runtimes=[
        MontyRuntime(captures=["python", "python3"]),
        RemoteRuntime(captures=["python", "python3"], machine="box"),
    ],
    # route le calcul sous-jacent : les lignes numpy tournent sur la machine, le reste sur monty
    route_policy=lambda ctx: "remote" if "numpy" in ctx.line else None,
)

# ajoute un agent qui utilise le profil analyst
alice = await ws.session("alice", profile="analyst")

# un seul grep balaie S3, Slack et Gmail, via la recherche propre à chaque service quand elle existe
await alice.shell("grep -rlw invoice /s3 /slack /gmail")

# exécute sur monty un script hébergé dans Slack, écrit le rapport dans S3
await alice.shell("python3 /slack/channels/general__C0123/2026-10-21/files/report__F0456.py > /s3/report.txt")

# numpy n'est pas dans monty, donc la politique de routage envoie cette ligne à e2b
await alice.shell("python3 -c 'import numpy; print(numpy.arange(10).sum())'")
```

Et ce que `alice` voit dans le shell :

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

## À propos

- **Une interface de terminal virtuel unifiée, au lieu de N SDK et M MCP.** Chaque backend parle la même sémantique de système de fichiers, si bien que les pipelines se composent entre services.
- **Un système de fichiers virtuel sur toutes les sources.** S3, Google Drive, Slack, Gmail, Redis et les autres se montent côte à côte sous une seule racine, si bien qu'un agent les atteint tous via une interface unifiée, avec les outils unix qu'il connaît déjà comme `ls`, `grep`, `find` et `jq`.
- **Outils en ligne de commande virtuels (CLI).** `git`, `slack` et `ntn` sont servis par Mirage lui-même, si bien qu'un agent pilote le service sans rien installer, à travers différents runtimes et machines, et un même outil peut être virtualisé en deux ou plus, chacun sous son propre nom avec ses propres identifiants.
- **Runtimes dynamiques et routés.** Python, JavaScript et n'importe quelle autre commande peuvent être envoyés au runtime configuré, en processus, en bac à sable ou à distance, ce qui découple le calcul du stockage et permet de changer l'un sans toucher à l'autre.
- **Le shell Mirage virtualisé.** Il relie le système de fichiers, les CLI et les runtimes en une seule ligne de commande, si bien que tubes, redirections, variables, jobs et historique fonctionnent à travers les trois.
- **Léger par conception.** Un espace de travail, le terminal virtuel lui-même, occupe environ 100 Ko de mémoire et chaque nouvelle session environ 10 Ko, si bien qu'un seul processus sert de nombreux agents sans conteneur ni VM par agent.
- **Des profils conçus pour les agents.** `allow`, `ask` et `deny` régissent les commandes et les CLI, tandis que `hide` et `show` régissent fichiers et dossiers, si bien qu'un chemin masqué n'est pas seulement illisible mais absent du système de fichiers que voit l'agent.
- **Un moteur de politiques scriptable.** Un script de politique peut interdire toute action dangereuse avant son exécution, et la même pile filtre chaque opération VFS et chaque écriture de session, si bien que ni un fichier ni une variable d'environnement ne fuit.
- **Des notifications câblées au VFS et aux agents.** Les changements externes deviennent un flux d'événements sur le montage, si bien qu'une nouvelle réponse Slack apparaît comme une modification du fichier de conversation dans le système de fichiers virtuel, et l'agent y réagit au lieu de re-parcourir l'arborescence.

## Système de fichiers virtuel

[Mirage](https://www.strukto.ai/mirage) « monte » tout comme un seul système de fichiers virtuel unifié pour les agents IA. Chaque service se place côte à côte sous une seule racine et répond à la même sémantique POSIX.

|                                                | VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stockage objet**                             | <a href="https://aws.amazon.com/s3/"><img src="https://api.iconify.design/logos/aws-s3.svg" width="20" height="20" alt="Amazon S3" title="Amazon S3" /></a>  <a href="https://developers.cloudflare.com/r2/"><img src="https://cdn.simpleicons.org/cloudflare" width="20" height="20" alt="Cloudflare R2" title="Cloudflare R2" /></a>  <a href="https://cloud.google.com/storage"><img src="https://api.iconify.design/logos/google-cloud.svg" width="25" height="20" alt="Google Cloud Storage" title="Google Cloud Storage" /></a>  <a href="https://www.oracle.com/cloud/storage/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/oracle.svg" width="32" height="20" alt="Oracle OCI" title="Oracle OCI" /></a>  <a href="https://supabase.com/storage"><img src="https://api.iconify.design/logos/supabase-icon.svg" width="19" height="20" alt="Supabase Storage" title="Supabase Storage" /></a>  <a href="https://min.io"><img src="https://cdn.simpleicons.org/minio" width="20" height="20" alt="MinIO" title="MinIO" /></a>  <a href="https://ceph.io/en/discover/technology/"><img src="https://cdn.simpleicons.org/ceph" width="20" height="20" alt="Ceph" title="Ceph" /></a>  <a href="https://github.com/seaweedfs/seaweedfs"><img src="../assets/icons/seaweedfs.svg" width="20" height="20" alt="SeaweedFS" title="SeaweedFS" /></a>  <a href="https://wasabi.com/cloud-object-storage"><img src="https://cdn.simpleicons.org/wasabi" width="20" height="20" alt="Wasabi" title="Wasabi" /></a>  <a href="https://www.backblaze.com/cloud-storage"><img src="https://cdn.simpleicons.org/backblaze" width="20" height="20" alt="Backblaze B2" title="Backblaze B2" /></a>  <a href="https://www.digitalocean.com/products/spaces"><img src="https://cdn.simpleicons.org/digitalocean" width="20" height="20" alt="DigitalOcean Spaces" title="DigitalOcean Spaces" /></a>  <a href="https://www.alibabacloud.com/product/oss"><img src="https://cdn.simpleicons.org/alibabacloud" width="20" height="20" alt="Alibaba Cloud OSS" title="Alibaba Cloud OSS" /></a>  <a href="https://www.tencentcloud.com/products/cos"><img src="../assets/icons/tencent.png" width="20" height="20" alt="Tencent Cloud COS" title="Tencent Cloud COS" /></a>  <a href="https://www.scaleway.com/en/object-storage/"><img src="https://cdn.simpleicons.org/scaleway" width="20" height="20" alt="Scaleway" title="Scaleway" /></a>  <a href="https://www.qingcloud.com/products/qingstor"><img src="../assets/icons/qingstor.png" width="20" height="20" alt="QingStor" title="QingStor" /></a>  <a href="https://huggingface.co/docs/hub/storage-buckets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Buckets" title="Hugging Face Buckets" /></a>  <a href="https://www.mongodb.com/docs/manual/core/gridfs/"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="GridFS" title="GridFS" /></a> |
| **Fichiers et documents**                      | <a href="https://workspace.google.com/products/drive/"><img src="https://cdn.simpleicons.org/googledrive" width="20" height="20" alt="Google Drive" title="Google Drive" /></a>  <a href="https://docs.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-docs.svg" width="14" height="20" alt="Google Docs" title="Google Docs" /></a>  <a href="https://sheets.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-sheets.svg" width="15" height="20" alt="Google Sheets" title="Google Sheets" /></a>  <a href="https://slides.google.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-slides.svg" width="15" height="20" alt="Google Slides" title="Google Slides" /></a>  <a href="https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-onedrive.svg" width="30" height="20" alt="OneDrive" title="OneDrive" /></a>  <a href="https://www.microsoft.com/microsoft-365/sharepoint/collaboration"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/microsoft-sharepoint.svg" width="20" height="20" alt="SharePoint" title="SharePoint" /></a>  <a href="https://www.box.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/box.svg" width="20" height="20" alt="Box" title="Box" /></a>  <a href="https://www.dropbox.com"><img src="https://cdn.simpleicons.org/dropbox" width="20" height="20" alt="Dropbox" title="Dropbox" /></a>  <a href="https://nextcloud.com/files/"><img src="https://cdn.simpleicons.org/nextcloud" width="20" height="20" alt="Nextcloud" title="Nextcloud" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Messagerie et travail**                      | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="Slack" title="Slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="Discord" title="Discord" /></a>  <a href="https://mail.google.com"><img src="https://cdn.simpleicons.org/gmail" width="20" height="20" alt="Gmail" title="Gmail" /></a>  <a href="https://en.wikipedia.org/wiki/Internet_Message_Access_Protocol"><img src="https://api.iconify.design/lucide/mail.svg?color=%23888888" width="20" height="20" alt="IMAP / SMTP email" title="IMAP / SMTP email" /></a>  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="GitHub" title="GitHub" /></a>  <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="Linear" title="Linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="Notion" title="Notion" /></a>  <a href="https://trello.com"><img src="https://cdn.simpleicons.org/trello" width="20" height="20" alt="Trello" title="Trello" /></a>  <a href="https://workspace.google.com/products/calendar/"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/google-calendar.svg" width="20" height="20" alt="Google Calendar" title="Google Calendar" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Bases de données et plateformes de données** | <a href="https://www.postgresql.org"><img src="https://cdn.simpleicons.org/postgresql" width="20" height="20" alt="PostgreSQL" title="PostgreSQL" /></a>  <a href="https://www.mongodb.com"><img src="https://cdn.simpleicons.org/mongodb" width="20" height="20" alt="MongoDB" title="MongoDB" /></a>  <a href="https://redis.io"><img src="https://cdn.simpleicons.org/redis" width="20" height="20" alt="Redis" title="Redis" /></a> <a href="https://upstash.com"><img src="https://cdn.simpleicons.org/upstash" width="20" height="20" alt="Upstash Redis" title="Upstash Redis" /></a>  <a href="https://lancedb.com"><img src="../assets/icons/lancedb.png" width="20" height="20" alt="LanceDB" title="LanceDB" /></a>  <a href="https://qdrant.tech"><img src="https://cdn.simpleicons.org/qdrant" width="20" height="20" alt="Qdrant" title="Qdrant" /></a>  <a href="https://www.trychroma.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/chroma.svg" width="31" height="20" alt="Chroma" title="Chroma" /></a>  <a href="https://mem0.ai"><img src="../docs/images/mem0.svg" width="20" height="20" alt="Mem0" title="Mem0" /></a>  <a href="https://huggingface.co/datasets"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Datasets" title="Hugging Face Datasets" /></a>  <a href="https://huggingface.co/models"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Models" title="Hugging Face Models" /></a>  <a href="https://huggingface.co/spaces"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="Hugging Face Spaces" title="Hugging Face Spaces" /></a>  <a href="https://docs.databricks.com/aws/en/volumes/"><img src="https://cdn.simpleicons.org/databricks" width="20" height="20" alt="Databricks Volumes" title="Databricks Volumes" /></a>  <a href="https://dify.ai"><img src="https://cdn.simpleicons.org/dify" width="20" height="20" alt="Dify" title="Dify" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Observabilité**                              | <a href="https://langfuse.com"><img src="../docs/images/langfuse-logo.svg" width="20" height="20" alt="Langfuse" title="Langfuse" /></a>  <a href="https://www.jaegertracing.io"><img src="https://cdn.simpleicons.org/jaeger" width="20" height="20" alt="Jaeger" title="Jaeger" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Local et distant**                           | <a href="https://en.wikipedia.org/wiki/Random-access_memory"><img src="https://api.iconify.design/lucide/memory-stick.svg?color=%23888888" width="20" height="20" alt="RAM" title="RAM" /></a>  <a href="https://en.wikipedia.org/wiki/File_system"><img src="https://api.iconify.design/lucide/hard-drive.svg?color=%23888888" width="20" height="20" alt="Disk" title="Disk" /></a>  <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system"><img src="https://api.iconify.design/lucide/folder-lock.svg?color=%23888888" width="20" height="20" alt="OPFS" title="OPFS" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Les agents y accèdent par les SDK Python et TypeScript, le CLI `mirage` ou un vrai point de montage via FUSE et FSKit, puis le manipulent avec les outils unix qu'ils connaissent déjà, comme `ls`, `grep`, `find` et `jq`.

## Outils en ligne de commande virtuels

Ces outils en ligne de commande sont virtualisés : [Mirage](https://www.strukto.ai/mirage) répond lui-même à `git`, `slack` ou `ntn`, si bien qu'un agent pilote le service sans que le programme soit installé sur la machine. Chacun imite l'outil réel, donc un agent qui connaît le CLI n'a rien de nouveau à apprendre. Parce qu'ils sont virtuels, un même outil peut être installé plusieurs fois sous des noms différents, chacun avec ses propres identifiants, si bien que chaque agent obtient exactement les comptes qui lui sont confiés.

|                        | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code**               | <a href="https://git-scm.com"><img src="https://cdn.simpleicons.org/git" width="20" height="20" alt="git" title="git" /></a>  <a href="https://cli.github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="20" height="20" alt="gh" title="gh" /></a>                                                                                                                                                                                                                                                                                           |
| **Communication**      | <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="20" height="20" alt="slack" title="slack" /></a>  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="20" height="20" alt="discord" title="discord" /></a>  <a href="https://github.com/pimalaya/himalaya"><img src="../assets/icons/himalaya.png" width="20" height="20" alt="himalaya" title="himalaya" /></a>                                                                                                                         |
| **Travail et données** | <a href="https://linear.app"><img src="https://cdn.simpleicons.org/linear" width="20" height="20" alt="linear" title="linear" /></a>  <a href="https://www.notion.so"><img src="https://cdn.simpleicons.org/notion/000000/e6edf3" width="20" height="20" alt="ntn" title="ntn" /></a>  <a href="https://workspace.google.com"><img src="https://cdn.simpleicons.org/google" width="20" height="20" alt="gws" title="gws" /></a>  <a href="https://huggingface.co"><img src="https://cdn.simpleicons.org/huggingface" width="20" height="20" alt="hf" title="hf" /></a> |

## Runtime virtuel

Les runtimes sont virtualisés de la même façon, et pas seulement pour les langages de programmation. N'importe quelle commande de la ligne peut être redirigée vers un runtime configuré : Python peut ainsi s'exécuter en processus avec [Monty](https://pydantic.dev/articles/pydantic-monty) tandis qu'une autre commande, disons `kubectl`, est envoyée à une machine distante via SSH. Le runtime qui sert une ligne donnée peut être choisi par un [routeur de runtimes scripté](https://docs.mirage.strukto.ai/home/policy/route-runtime).

|                | Runtimes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python**     | <a href="https://pydantic.dev/articles/pydantic-monty"><img src="https://cdn.simpleicons.org/pydantic" width="20" height="20" alt="Monty" title="Monty" /></a>  <a href="https://wasi.dev"><img src="https://cdn.simpleicons.org/webassembly" width="20" height="20" alt="WASI CPython on wasmtime" title="WASI CPython on wasmtime" /></a>  <a href="https://pyodide.org"><img src="../assets/icons/pyodide.svg" width="56" height="20" alt="Pyodide" title="Pyodide" /></a>  <a href="https://pypi.org/project/sandlock/"><img src="../docs/images/sandlock-logo.svg" width="20" height="20" alt="sandlock" title="sandlock" /></a>  <a href="https://www.python.org"><img src="https://cdn.simpleicons.org/python" width="20" height="20" alt="Host CPython" title="Host CPython" /></a>                                                                                                                                                                                                                                                   |
| **JavaScript** | <a href="https://docs.mirage.strukto.ai/home/setup/runtime/quickjs"><img src="../assets/icons/quickjs.png" width="20" height="20" alt="QuickJS, serving node and js" title="QuickJS, serving node and js" /></a> <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript"><img src="https://cdn.simpleicons.org/javascript" width="20" height="20" alt="JavaScript" title="JavaScript" /></a> <a href="https://www.typescriptlang.org"><img src="https://cdn.simpleicons.org/typescript" width="20" height="20" alt="TypeScript" title="TypeScript" /></a>                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Machines**   | <a href="https://www.docker.com"><img src="https://cdn.simpleicons.org/docker" width="20" height="20" alt="Docker" title="Docker" /></a>  <a href="https://e2b.dev"><img src="../docs/images/e2b-logo.svg" width="20" height="20" alt="E2B" title="E2B" /></a>  <a href="https://www.daytona.io"><img src="../docs/images/daytona-logo.svg" width="20" height="20" alt="Daytona" title="Daytona" /></a>  <a href="https://smolmachines.com"><img src="../docs/images/smolvm-logo.svg" width="20" height="20" alt="smolVM" title="smolVM" /></a> <a href="https://microsandbox.dev"><img src="../docs/images/microsandbox-logo.svg" width="20" height="20" alt="Microsandbox" title="Microsandbox" /></a> <a href="https://github.com/apple/container"><img src="https://cdn.simpleicons.org/apple/000000/e6edf3" width="20" height="20" alt="Apple Container" title="Apple Container" /></a>  <a href="https://en.wikipedia.org/wiki/Secure_Shell"><img src="../docs/images/ssh-logo.svg" width="20" height="20" alt="SSH" title="SSH" /></a> |

## Sécurité

Un profil décide de ce qu'une session peut exécuter et de ce qu'elle peut voir. Les commandes sont régies par des règles `allow`, `ask` et `deny` personnalisables, et les chemins par `hide` et `show`, si bien qu'un fichier masqué n'est pas seulement illisible mais absent du système de fichiers que voit l'agent. Pour tout ce que ces règles ne peuvent exprimer, un profil peut désigner un script de politique qui s'exécute à l'entrée de chaque commande et répond lui-même allow, deny ou ask, mais comme toute règle il ne peut que restreindre, jamais accorder. Par ailleurs, un hôte peut enregistrer ses propres politiques sur le [moteur de politiques](https://docs.mirage.strukto.ai/home/policy/policies), une pile ordonnée que l'espace de travail consulte à chaque commande, opération VFS et écriture de session. Voir la [documentation des politiques](https://docs.mirage.strukto.ai/home/policy/overview).

## Identifiants de service

Les identifiants de service s'intègrent aux coffres où vivent déjà les secrets, dont AWS Secrets Manager, 1Password et dotenv, si bien qu'une variable d'environnement dans Mirage peut se résoudre directement en un identifiant conservé dans l'un d'eux.

|                    | Sources                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intégrées**      | <a href="https://en.wikipedia.org/wiki/Environment_variable"><img src="../assets/icons/terminal.svg" width="20" height="20" alt="Environment" title="Environment" /></a> <a href="https://www.dotenv.org"><img src="https://cdn.simpleicons.org/dotenv" width="20" height="20" alt="dotenv" title="dotenv" /></a>                                          |
| **Personnalisées** | <a href="https://1password.com"><img src="https://cdn.simpleicons.org/1password" width="20" height="20" alt="1Password" title="1Password" /></a> <a href="https://aws.amazon.com/secrets-manager/"><img src="https://api.iconify.design/logos/aws-secrets-manager.svg" width="20" height="20" alt="AWS Secrets Manager" title="AWS Secrets Manager" /></a> |

## Installation

- **Python** ≥ 3.12 pour le paquet `mirage-ai` et le CLI `mirage`
- **Node.js** 22.20+ sur Node 22, 24.12+ sur Node 24, ou 25+ pour le SDK TypeScript

### Python

```bash
uv add mirage-ai              # installe la bibliothèque `mirage` et le binaire CLI `mirage`
uv add 'mirage-ai[openai]'    # adaptateur OpenAI Agents ; chaque framework d'agents est un extra
uv add 'mirage-ai[monty]'     # Monty, le runtime Python en processus des exemples
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # serveurs Node.js et CLI
npm install @struktoai/mirage-browser   # navigateur / runtimes edge
npm install @struktoai/mirage-vercel    # adaptateur Vercel AI ; chaque framework d'agents a son propre paquet
```

Les deux paquets runtime installent automatiquement `@struktoai/mirage-core`.

### CLI

```bash
npm install -g @struktoai/mirage-cli
# ou
uvx --from mirage-ai mirage
# ou
npx @struktoai/mirage-cli
```

Pour démarrer, consultez les guides de démarrage rapide pour [Python](https://docs.mirage.strukto.ai/python/quickstart), [TypeScript](https://docs.mirage.strukto.ai/typescript/quickstart) et le [CLI](https://docs.mirage.strukto.ai/home/access/cli).

## Politiques scriptables

Un profil peut désigner des scripts de politique pour ce que ses règles ne peuvent exprimer. Le `pre_command` d'un script reçoit la commande, peut ouvrir les fichiers qu'elle nomme et renvoie un deny, un ask ou `None`. Celui-ci désactive `rm`, ainsi que tout script Python dont le code supprime des fichiers :

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

Enregistrez-le dans un profil, ici pour qu'il s'exécute sur Monty avant chaque commande :

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

Voir les [scripts de politique](https://docs.mirage.strukto.ai/home/policy/scripts) pour les autres étapes auxquelles un script peut répondre.

## Terminal embarqué

La plupart du temps, un agent n'a pas besoin d'un bac à sable, seulement d'une interface de type terminal, et Mirage en embarque une dans un serveur d'application. Chaque terminal est une session Mirage avec son propre répertoire de travail, son environnement et son historique, et Python s'exécute en processus sur Monty, si bien qu'un terminal démarre sans conteneur ni VM. Le voici avec Express ; la version FastAPI se trouve dans la [documentation](https://docs.mirage.strukto.ai/home/examples/embedded-terminal).

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

## Contributeurs

Merci à toutes les personnes qui ont contribué à Mirage.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Contributeurs de Mirage" />
</a>
