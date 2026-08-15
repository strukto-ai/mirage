<p align="center">
  <img src="../assets/mirage-og-light@2x.png" alt="Mirage : un système de fichiers virtuel unifié pour les agents IA" width="900">
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Documentation">
        <img src="https://img.shields.io/badge/mirage-documentation-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="Site web">
        <img src="https://img.shields.io/badge/par-strukto.ai-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="Licence">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=licence&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Communauté Discord">
        <img src="https://img.shields.io/badge/discord-rejoindre-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
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
  <a href="./README.vi.md"><img alt="README Tiếng Việt" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
  <a href="./README.ko.md"><img alt="README 한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-d9d9d9"></a>
</p>

Mirage est **un système de fichiers virtuel unifié pour les agents IA** : il monte des services et des sources de données comme S3, Google Drive, Slack, Gmail et Redis côte à côte dans un même système de fichiers. Tout LLM qui connaît déjà bash peut lire, chercher avec grep et chaîner des pipes sur chaque backend dès le départ, sans vocabulaire nouveau.

```python
ws = Workspace(
    {
        "/tmp":   (RAMResource(), MountMode.EXEC),
        "/redis": (RedisResource(url=redis_url), MountMode.WRITE),
        "/slack": (SlackResource(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
    },
    # monty capture python : les scripts s'exécutent en bac à sable dans l'espace de travail
    runtimes=[MontyRuntime(captures=["python", "python3"]), "vfs"],
)

# un seul grep balaie toutes les sources
await ws.execute("grep -rln session /redis /tmp")

# exécute un script hébergé dans Slack, écrit le rapport dans Redis
await ws.execute(
    "python3 /slack/channels/general__C0.../files/example__F0....py > /redis/report.txt"
)

# installe un CLI typé sous un mot-clé : dispatché par nom, pas par chemin,
# et découvrable via `man`, `type` et `which` comme tout autre programme
ws.register_cli("slack", SLACK, {"token": slack_bot_token})
await ws.execute('slack send-message --channel general --text "report is up"')
```

## À propos

- **Une seule interface au lieu de N SDK et M MCP.** Chaque service parle la même sémantique de système de fichiers, et les pipelines se composent entre services aussi naturellement que sur un disque local.
- **Une cinquantaine de backends intégrés :** RAM, Disk, Redis, S3 / R2 / OCI / Supabase / GCS, Gmail / GDrive / GDocs / GSheets / GSlides, GitHub / Linear / Notion / Trello, Slack / Discord / Email, MongoDB / GridFS / Postgres / LanceDB / Qdrant, SSH et plus encore, montés côte à côte sous une même racine.
- **Espaces de travail portables :** cloner, snapshotter et versionner un espace de travail ; les exécutions d'agents se déplacent entre machines sans redémarrage ni reconfiguration du système.
- **Embarquable :** les SDK Python et TypeScript s'exécutent dans le processus, au sein de FastAPI, Express, d'applications navigateur ou de tout runtime asynchrone ; aucun processus séparé n'est requis.
- **Intégrations d'agents :** OpenAI Agents SDK, Vercel AI SDK, LangChain, Pydantic AI, CAMEL et OpenHands via les SDK ; les agents de code via des adaptateurs natifs, des plugins installables, MCP ou FUSE.

## Architecture

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Architecture de Mirage : agent IA et application → Mirage Bash et VFS → Dispatcher et cache → infrastructure et services distants" width="720">
  </picture>
</p>

## Installation

- **Python** ≥ 3.11 pour le paquet `mirage-ai` et le CLI `mirage`
- **Node.js** ≥ 20 pour le SDK TypeScript
- **macOS** ou **Linux** (les montages FUSE nécessitent le support de la plateforme)

### Python

```bash
uv add mirage-ai    # installe la bibliothèque `mirage` et le binaire CLI `mirage`
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # serveurs Node.js et CLI
npm install @struktoai/mirage-browser   # navigateur / runtimes edge
npm install @struktoai/mirage-agents    # adaptateurs OpenAI / Vercel AI / LangChain / Mastra
```

Les deux paquets runtime installent automatiquement `@struktoai/mirage-core`.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
# ou
npm install -g @struktoai/mirage-cli
# ou
uvx mirage-ai
# ou
npx @struktoai/mirage-cli
```

## Démarrage rapide

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

## Frameworks d'agents

Mirage s'intègre aux frameworks d'agents comme bac à sable ou couche d'outils. Les opérations POSIX telles que `read` peuvent aussi être personnalisées par ressource et par type de fichier : Mirage n'embarque aucun moteur de rendu de format, donc un format s'affiche selon ce que vous enregistrez, et une commande enregistrée pour une ressource et une extension l'emporte sur la commande générique.

|                | Intégrations                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python         | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents), [LangChain](https://docs.mirage.strukto.ai/python/agents/langchain), [Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai), [CAMEL](https://docs.mirage.strukto.ai/python/agents/camel), [OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands), [Agno](https://docs.mirage.strukto.ai/python/agents/agno)      |
| TypeScript     | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel), [OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai), [LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain), [Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                              |
| Agents de code | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code), [Codex](https://docs.mirage.strukto.ai/typescript/agents/codex), [DeepSeek Harness](https://docs.mirage.strukto.ai/typescript/agents/dsh), [Grok Build](https://docs.mirage.strukto.ai/typescript/agents/grok-build), [OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode), [Pi](https://docs.mirage.strukto.ai/typescript/agents/pi) |

## Cache

Chaque `Workspace` possède un cache à deux niveaux, pour que le travail répété contre des backends distants touche l'état local plutôt que le réseau :

- **Cache d'index :** listages et métadonnées. Le premier parcours de répertoire appelle l'API ; les suivants sont servis par l'index jusqu'à expiration du TTL (10 minutes par défaut).
- **Cache de fichiers :** octets des objets. La première lecture est streamée depuis l'origine ; les pipelines suivants lisent le cache (512 Mo par défaut).

Les deux niveaux utilisent par défaut la RAM du processus, sans configuration. Un store Redis partage l'état du cache entre workers, processus et machines :

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

Voir la [documentation du cache](https://docs.mirage.strukto.ai/home/cache) pour le cycle de vie complet miss/hit.

## Contributeurs

Merci à toutes les personnes qui ont contribué à Mirage.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Contributeurs de Mirage" />
</a>
