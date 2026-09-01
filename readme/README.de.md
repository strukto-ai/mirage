<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-og-dark@2x.png">
    <img src="../assets/mirage-og-light@2x.png" alt="Mirage: ein virtuelles Terminal für KI-Agenten" width="900">
  </picture>
</p>

<p align="center">
    <a href="https://docs.mirage.strukto.ai" alt="Dokumentation">
        <img src="https://img.shields.io/badge/mirage-dokumentation-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://www.strukto.ai" alt="Website">
        <img src="https://img.shields.io/badge/von-strukto.ai-0C0C0C?labelColor=FAFAFA" /></a>
    <a href="https://github.com/strukto-ai/mirage/blob/main/LICENSE" alt="Lizenz">
        <img src="https://img.shields.io/github/license/strukto-ai/mirage?label=lizenz&color=0C0C0C&labelColor=FAFAFA" /></a>
    <a href="https://discord.gg/u8BPQ65KsS" alt="Discord-Community">
        <img src="https://img.shields.io/badge/discord-beitreten-0C0C0C?labelColor=FAFAFA&logo=discord&logoColor=0C0C0C" /></a>
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

Mirage ist **ein virtuelles Terminal für KI-Agenten**. Das virtuelle Dateisystem liefert breiten Datenkontext, virtualisierte CLIs geben einem Agenten mehr Spielraum beim Werkzeugeinsatz, dynamische Laufzeitumgebungen senken die Kosten der darunterliegenden Infrastruktur und sparen Tokens, und eine feingranulare Kontrolle über die Aktionen eines Agenten und sogar darüber, was er sehen darf, sorgt für die beste Sicherheit. Zusammen bilden diese Teile ein einziges virtualisiertes Terminal, das die beste Agentenleistung, Kosteneffizienz und Sicherheit bietet.

```python
ws = Workspace(
    {
        "/tmp":   (RAMResource(), MountMode.EXEC),
        "/redis": (RedisResource(url=redis_url), MountMode.WRITE),
        "/slack": (SlackResource(SlackConfig(token=slack_bot_token)), MountMode.EXEC),
    },
    # monty fängt python ab, Skripte laufen also sandboxed im Workspace
    runtimes=[MontyRuntime(captures=["python", "python3"]), "vfs"],
)

# ein einziges grep durchsucht alle Quellen
await ws.execute("grep -rln session /redis /tmp")

# führt ein Skript aus, das in Slack liegt, und schreibt den Bericht nach Redis
await ws.execute("python3 /slack/channels/general_.../files/example__F....py > /redis/report.txt")

# installiert eine typisierte CLI unter einem Kopfwort: per Name verteilt, nicht per Pfad,
# und über `man`, `type` und `which` auffindbar wie jedes andere Programm
ws.register_cli("slack", SLACK, {"token": slack_bot_token})
await ws.execute('slack send-message --channel general --text "report is up"')
```

## Überblick

- **Eine einheitliche virtuelle Terminal-Schnittstelle statt N SDKs und M MCPs.** Jedes Backend spricht dieselbe Dateisystem-Semantik, sodass sich Pipelines über Dienste hinweg zusammensetzen lassen.
- **Ein virtuelles Dateisystem über alle Quellen.** S3, Google Drive, Slack, Gmail, Redis und die übrigen werden nebeneinander unter einer einzigen Wurzel eingehängt, sodass ein Agent sie alle über eine einheitliche Schnittstelle erreicht, mit den Unix-Werkzeugen, die er ohnehin kennt, etwa `ls`, `grep`, `find` und `jq`.
- **Virtuelle Kommandozeilenwerkzeuge (CLIs).** `git`, `slack` und `ntn` beantwortet Mirage selbst, sodass ein Agent den Dienst ohne jede Installation bedient, über verschiedene Laufzeitumgebungen und Maschinen hinweg; ein Werkzeug lässt sich zudem in zwei oder mehr virtualisieren, jedes unter eigenem Namen mit eigenen Zugangsdaten.
- **Geroutete, dynamische Laufzeitumgebungen.** Python, JavaScript und jeder andere Befehl kann an eine konfigurierte Laufzeitumgebung geschickt werden, im Prozess, in einer Sandbox oder entfernt, was Berechnung von Speicher entkoppelt und beide unabhängig voneinander austauschbar macht.
- **Die virtualisierte Mirage-Shell.** Sie verbindet Dateisystem, CLIs und Laufzeitumgebungen zu einer einzigen Kommandozeile, sodass Pipes, Umleitungen, Variablen, Jobs und History über alle drei hinweg funktionieren.
- **Profile, die für Agenten entworfen sind.** `allow`, `ask` und `deny` steuern Befehle und CLIs, `hide` und `show` steuern Dateien und Ordner, sodass ein verborgener Pfad nicht bloß unlesbar ist, sondern in dem Dateisystem, das der Agent sieht, gar nicht existiert.
- **Eine skriptfähige Policy-Engine.** Ein Policy-Skript kann jede gefährliche Aktion verhindern, bevor sie ausgeführt wird, und derselbe Stapel prüft jede VFS-Operation und jeden Session-Schreibzugriff, sodass weder eine Datei noch eine Umgebungsvariable nach außen dringt.
- **Benachrichtigungen, die mit dem VFS und den Agenten verdrahtet sind.** Externe Änderungen werden zu einem Ereignisstrom auf dem Mount, sodass eine neue Slack-Antwort als Änderung der Chat-Datei im virtuellen Dateisystem erscheint und der Agent darauf reagiert, statt den Baum erneut zu durchsuchen.

## Architektur

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/mirage-arch-dark.svg">
    <img src="../assets/mirage-arch-light.svg" alt="Mirage-Architektur: Agenten und Harness erreichen Profile und die Mirage-Shell, die Unix-artige Befehle, virtuelle CLIs und Programmiersprachen auf Laufzeitumgebungen und das virtuelle Dateisystem auflösen, mit Authentifizierung, Policy-Engine und Benachrichtigungen daneben" width="100%">
  </picture>
</p>

## Installation

- **Python** ≥ 3.11 für das Paket `mirage-ai` und die CLI `mirage`
- **Node.js** ≥ 20 für das TypeScript-SDK
- **macOS** oder **Linux** (FUSE-Mounts brauchen Unterstützung durch die Plattform)

### Python

```bash
uv add mirage-ai    # installiert die Bibliothek `mirage` und die CLI `mirage`
```

### TypeScript

```bash
npm install @struktoai/mirage-node      # Node.js-Server und CLI
npm install @struktoai/mirage-browser   # Browser- und Edge-Laufzeitumgebungen
npm install @struktoai/mirage-agents    # Adapter für OpenAI / Vercel AI / LangChain / Mastra
```

Beide Runtime-Pakete installieren `@struktoai/mirage-core` automatisch mit.

### CLI

```bash
curl -fsSL https://strukto.ai/mirage/install.sh | sh
# oder
npm install -g @struktoai/mirage-cli
# oder
uvx mirage-ai
# oder
npx @struktoai/mirage-cli
```

## Schnellstart

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

## Agenten-Frameworks

Mirage lässt sich in Agenten-Frameworks als Sandbox oder als Werkzeugschicht einbinden. POSIX-Operationen wie `read` sind außerdem pro Ressource und pro Dateityp anpassbar: Mirage bringt keine Renderer für Dateiformate mit, ein Format wird also so dargestellt, wie es registriert wurde, und ein für eine Ressource und eine Endung registrierter Befehl schlägt den generischen.

|                | Integrationen                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python         | [OpenAI Agents SDK](https://docs.mirage.strukto.ai/python/agents/openai-agents), [LangChain](https://docs.mirage.strukto.ai/python/agents/langchain), [Pydantic AI](https://docs.mirage.strukto.ai/python/agents/pydantic-ai), [CAMEL](https://docs.mirage.strukto.ai/python/agents/camel), [OpenHands](https://docs.mirage.strukto.ai/python/agents/openhands), [Agno](https://docs.mirage.strukto.ai/python/agents/agno)      |
| TypeScript     | [Vercel AI SDK](https://docs.mirage.strukto.ai/typescript/agents/vercel), [OpenAI Agents SDK](https://docs.mirage.strukto.ai/typescript/agents/openai), [LangChain](https://docs.mirage.strukto.ai/typescript/agents/langchain), [Mastra](https://docs.mirage.strukto.ai/typescript/agents/mastra)                                                                                                                              |
| Coding-Agenten | [Claude Code](https://docs.mirage.strukto.ai/python/agents/claude-code), [Codex](https://docs.mirage.strukto.ai/typescript/agents/codex), [DeepSeek Harness](https://docs.mirage.strukto.ai/typescript/agents/dsh), [Grok Build](https://docs.mirage.strukto.ai/typescript/agents/grok-build), [OpenCode](https://docs.mirage.strukto.ai/typescript/agents/opencode), [Pi](https://docs.mirage.strukto.ai/typescript/agents/pi) |

## Cache

Jeder `Workspace` hat einen zweistufigen Cache, damit wiederholte Arbeit gegen entfernte Backends lokalen Zustand trifft statt das Netzwerk:

- **Index-Cache:** Auflistungen und Metadaten. Der erste Verzeichnisdurchlauf ruft die API auf; die folgenden bedient der Index, bis die TTL abläuft (standardmäßig 10 Minuten).
- **Datei-Cache:** Objekt-Bytes. Der erste Lesevorgang wird vom Ursprung gestreamt; nachfolgende Pipelines lesen aus dem Cache (standardmäßig 512 MB).

Beide Stufen nutzen standardmäßig den Arbeitsspeicher des Prozesses, ganz ohne Konfiguration. Ein Redis-Store teilt den Cache-Zustand zwischen Workern, Prozessen und Maschinen:

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

Die [Cache-Dokumentation](https://docs.mirage.strukto.ai/home/cache) beschreibt den vollständigen Miss/Hit-Lebenszyklus.

## Mitwirkende

Dank an alle, die zu Mirage beigetragen haben.

<a href="https://github.com/strukto-ai/mirage/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=strukto-ai/mirage" alt="Mirage-Mitwirkende" />
</a>
