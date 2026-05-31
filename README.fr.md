<p align="center">
  <img src="assets/mirage-og-light@2x.png" alt="Mirage : un système de fichiers virtuel unifié pour les agents IA" width="900">
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
  <a href="./README.md"><img alt="README en anglais" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.zh-CN.md"><img alt="README en chinois simplifié" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./README.zh-TW.md"><img alt="README en chinois traditionnel" src="https://img.shields.io/badge/繁體中文-d9d9d9"></a>
  <a href="./README.fr.md"><img alt="README en français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./README.vi.md"><img alt="README en vietnamien" src="https://img.shields.io/badge/Ti%E1%BA%BFng%20Vi%E1%BB%87t-d9d9d9"></a>
</p>

Mirage est **un système de fichiers virtuel unifié pour les agents IA** : il monte des services et des sources de données comme S3, Google Drive, Slack, Gmail et Redis côte à côte dans une seule arborescence.

Les agents IA accèdent à chaque backend avec le même petit ensemble d'outils de type Unix, et les pipelines se composent entre services aussi naturellement que sur un disque local. C'est un environnement simulé : l'agent voit un seul système de fichiers sous-jacent. Tout LLM qui connaît déjà bash peut utiliser Mirage sans apprendre un nouveau vocabulaire.

```ts
const ws = new Workspace({
  '/data': new RAMResource(),
  '/s3': new S3Resource({ bucket: 'logs' }),
  '/slack': new SlackResource({}),
  '/github': new GitHubResource({}),
})

await ws.execute('grep alert /slack/general/*.json | wc -l')
await ws.execute('cat /github/mirage/README.md')
await ws.execute('cp /s3/report.csv /data/local.csv')
// Enregistre une nouvelle commande, disponible sur tous les montages.
ws.command('summarize', ...)

// Remplace une commande pour une ressource et un type de fichier précis.
// `cat` sur un fichier Parquet dans /s3 rend les lignes en JSON au lieu d'octets bruts.
ws.command('cat', { resource: 's3', filetype: 'parquet' }, ...)

await ws.execute('summarize /github/mirage/README.md')
await ws.execute('cat /s3/events/2026-05-06.parquet | jq .user')
```

## À propos

- **Un système de fichiers pour tous les backends.** Chaque service parle la même sémantique de système de fichiers, donc les agents raisonnent sur une seule abstraction au lieu de N SDK et M MCP, en s'appuyant sur le vocabulaire des fichiers et de bash que les LLM connaissent le mieux.
- **Plusieurs ressources, un seul système de fichiers :** RAM, Disk, Redis, S3 / R2 / OCI / Supabase / GCS, Gmail / GDrive / GDocs / GSheets / GSlides, GitHub / Linear / Notion / Trello, Slack / Discord / Telegram / Email, MongoDB, SSH, et plus encore, montés côte à côte sous une seule racine.
- **Des outils bash familiers sur chaque montage.** Les agents réutilisent le même ensemble d'outils de type Unix au lieu d'apprendre une nouvelle API par service, et les pipelines se composent entre services comme sur un disque local.
- **Workspaces portables :** clonez, prenez des snapshots et versionnez votre environnement. Déplacez les exécutions d'agents entre machines sans redémarrer ni reconfigurer le système.
- **Intégrable dans vos applications et services :** les SDK Python et TypeScript permettent de donner un système de fichiers virtuel directement aux agents IA dans FastAPI, Express, les applications navigateur ou tout runtime asynchrone, sans processus séparé.
- **Compatible avec les principaux frameworks d'agents :** OpenAI Agents SDK, Vercel AI SDK (TypeScript), LangChain, Pydantic AI, CAMEL et OpenHands.
- **CLI + daemon légers :** s'intègrent à des agents de code comme Claude Code et Codex pour accéder à toutes les ressources montées via bash, avec plus de travail utile par tour.

## Architecture

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mirage-arch-dark.svg">
    <img src="assets/mirage-arch-light.svg" alt="Architecture Mirage : agent IA et application → Mirage Bash et VFS → Dispatcher et cache → infrastructure et services distants" width="900">
  </picture>
</p>

## Installation

### Prérequis

- **Python** ≥ 3.12 pour le paquet `mirage-ai` et le CLI `mirage`
- **Node.js** ≥ 20 pour le SDK TypeScript
- **macOS** ou **Linux** (les montages basés sur FUSE nécessitent le support de la plateforme)

### Python

```bash
uv add mirage-ai
```

Cette commande installe à la fois la bibliothèque `mirage` et le binaire CLI `mirage`.

### TypeScript

Choisissez le paquet adapté à votre runtime :

```bash
npm install @struktoai/mirage-node      # serveurs Node.js et CLI
npm install @struktoai/mirage-browser   # navigateurs / runtimes edge
npm install @struktoai/mirage-core      # primitives indépendantes du runtime
```

`@struktoai/mirage-node` et `@struktoai/mirage-browser` importent automatiquement `@struktoai/mirage-core`.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
```

Ou via le gestionnaire de paquets de votre choix :

```bash
npm install -g @struktoai/mirage-cli
```

```bash
uvx mirage-ai
```

```bash
npx @struktoai/mirage-cli
```

## Démarrage rapide (Python)

```python
from mirage import Workspace
from mirage.resource.gdocs import GDocsConfig, GDocsResource
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.resource.slack import SlackConfig, SlackResource

ws = Workspace({
    "/data":  RAMResource(),
    "/s3":    S3Resource(S3Config(bucket="my-bucket")),
    "/slack": SlackResource(SlackConfig()),
    "/docs":  GDocsResource(GDocsConfig()),
})

await ws.execute("cp /s3/report.csv /data/report.csv")
await ws.execute("grep alert /s3/data/log.jsonl | wc -l")

ws.snapshot("demo.tar")
```

## Démarrage rapide (TypeScript)

```ts
import {
  Workspace,
  RAMResource,
  S3Resource,
  SlackResource,
  GDocsResource,
} from '@struktoai/mirage-browser'

const ws = new Workspace({
  '/data':  new RAMResource(),
  '/s3':    new S3Resource({ bucket: 'my-bucket' }),
  '/slack': new SlackResource({}),
  '/docs':  new GDocsResource({}),
})

await ws.execute('cp /s3/report.csv /data/report.csv')
await ws.execute('grep alert /s3/data/log.jsonl | wc -l')
```

## Démarrage rapide (CLI)

```bash
mirage workspace create ws.yaml --id demo
mirage execute   --workspace_id demo --command "cp /s3/report.csv /data/report.csv"
mirage provision --workspace_id demo --command "cat /s3/data/large.jsonl"
mirage workspace snapshot demo demo.tar
mirage workspace load demo.tar --id demo-restored
```

## Frameworks d'agents

Mirage s'intègre aux principaux frameworks d'applications d'agents comme sandbox ou couche d'outils. L'agent travaille sur le même arbre de montage que dans bash, donc changer de modèle ou de runtime ne change pas l'interface.

### OpenAI Agents SDK (Python)

`MirageSandboxClient` branche un `Workspace` dans OpenAI Agents SDK comme sandbox : les commandes bash lancées par l'agent s'exécutent sur vos montages.

```python
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import SandboxAgent, SandboxRunConfig

from mirage.agents.openai_agents import MirageSandboxClient

client = MirageSandboxClient(ws)
agent = SandboxAgent(
    name="Agent sandbox Mirage",
    model="gpt-5.4-nano",
    instructions=ws.file_prompt,
)

result = await Runner.run(
    agent,
    "Résume /s3/data/report.parquet dans /report.txt.",
    run_config=RunConfig(sandbox=SandboxRunConfig(client=client)),
)
```

### Vercel AI SDK (TypeScript)

`mirageTools(ws)` expose le workspace comme un ensemble d'outils typés pour AI SDK, afin que tout modèle connecté à AI SDK puisse lire et écrire entre montages, dans Node.js ou dans le navigateur.

```ts
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { mirageTools } from '@struktoai/mirage-agents/vercel'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'

const { text } = await generateText({
  model: openai('gpt-5.4-nano'),
  system: buildSystemPrompt({ mountInfo: { '/': 'Système de fichiers en mémoire' } }),
  prompt: "Utilise readFile pour lire /docs/paper.pdf, puis décris son contenu.",
  tools: mirageTools(ws),
})
```

Les adaptateurs LangChain, Pydantic AI, CAMEL, OpenHands et Mastra vivent à côté de ceux-ci.

## Cache

Chaque `Workspace` inclut un **cache à deux couches** afin que le travail répété contre les backends distants (S3, GDrive, Slack, etc.) touche l'état local au lieu du réseau :

- **Cache d'index.** Listes et métadonnées. La première traversée de répertoire appelle l'API ; les suivantes servent l'index jusqu'à expiration du TTL.
- **Cache de fichiers.** Octets des objets. La première lecture streame depuis l'origine ; les pipelines suivants lisent depuis le cache.
- **Backends enfichables.** Chaque couche est un store avec deux implémentations intégrées :
  - **RAM** (par défaut) : dans le processus, zéro configuration, cache de fichiers de 512 MB et TTL d'index de 10 minutes. Idéal pour les applications mono-processus et les notebooks.
  - **Redis** : partagé entre workers, processus et machines. Idéal pour serverless, les services multi-réplicas ou les caches qui doivent survivre aux redémarrages.

```ts
import { RedisFileCacheStore, RedisIndexCacheStore, Workspace } from 'mirage/node'

const ws = new Workspace(
  { '/s3': new S3Resource({ bucket: 'my-bucket' }) },
  {
    cache: new RedisFileCacheStore({ url: 'redis://localhost:6379/0', limit: '8GB' }),
    index: new RedisIndexCacheStore({ url: 'redis://localhost:6379/0', ttl: 600 }),
  },
)
```

```ts
import { S3Resource, Workspace } from 'mirage/node'

const ws = new Workspace({ '/s3': new S3Resource({ bucket: 'my-bucket' }) })

// 1. Index manquant → S3 LIST. La liste est stockée dans le cache d'index.
await ws.execute('ls /s3/data/')

// 2. Index touché → 0 appel réseau.
await ws.execute('find /s3/data/ -name "*.jsonl"')

// 3. Fichier manquant → S3 GET. Les octets sont stockés dans le cache de fichiers.
await ws.execute('cat /s3/data/log.jsonl | wc -l')

// 4. Fichier touché → 0 appel réseau.
await ws.execute('grep alert /s3/data/log.jsonl')
```

## Contributeurs

Merci à toutes les personnes qui ont contribué à Mirage.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Contributeurs de Mirage" />
</a>
