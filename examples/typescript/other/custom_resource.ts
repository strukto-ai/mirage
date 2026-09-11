// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Accessor,
  command,
  type CommandIO,
  CommandSpec,
  ContentType,
  eisdir,
  enoent,
  enotdir,
  FileStat,
  FileType,
  GenericResource,
  IOResult,
  MountMode,
  type PathSpec,
  registerResourceFactory,
  streamFromBytes,
  Workspace,
} from '@struktoai/mirage-node'

// A whole custom backend in one script: four core functions over your
// data source, one CommandIO table, one GenericResource. Every generic
// command (ls, cat, grep, find, head, wc, ...) works for free, and so
// does versioning, in the shape the content calls for: the wiki's pages
// are the resource's own, so they ride its state and a snapshot rebuilds
// the mount through the registered name with the pages as they were; the
// feed's live in a service, so the resource is only observed and a load
// asks for it back rather than restoring a copy.

const ENC = new TextEncoder()
const DEC = new TextDecoder()

type Tree = { [name: string]: Tree | string }

const PAGES: Tree = {
  guides: {
    'quickstart.md': '# Quickstart\nMount anything as a filesystem.\n',
    'deploy.md': '# Deploy\nShip the gateway behind HTTP.\n',
  },
  'notes.md': 'Remember: agents just speak bash.\n',
}

class WikiAccessor extends Accessor {
  constructor(public pages: Tree) {
    super()
  }
}

function node(pages: Tree, key: string): Tree | string {
  let current: Tree | string = pages
  for (const part of key.split('/').filter((p) => p !== '')) {
    // The errno constructors stamp `code`, which is what the command
    // chokepoints read to answer in GNU's voice: a bare `new Error('ENOENT')`
    // would surface as an internal failure instead.
    if (typeof current === 'string') throw enoent(key)
    const child: Tree | string | undefined = current[part]
    if (child === undefined) throw enoent(key)
    current = child
  }
  return current
}

function readdir(accessor: WikiAccessor, path: PathSpec): Promise<string[]> {
  const found = node(accessor.pages, path.resourcePath)
  if (typeof found === 'string') throw enotdir(path)
  const parent = path.virtual.replace(/\/+$/, '')
  return Promise.resolve(
    Object.entries(found).map(
      ([name, child]) => `${parent}/${name}${typeof child === 'string' ? '' : '/'}`,
    ),
  )
}

function readBytes(accessor: WikiAccessor, path: PathSpec): Promise<Uint8Array> {
  const found = node(accessor.pages, path.resourcePath)
  if (typeof found !== 'string') throw eisdir(path)
  return Promise.resolve(ENC.encode(found))
}

function stat(accessor: WikiAccessor, path: PathSpec): Promise<FileStat> {
  const found = node(accessor.pages, path.resourcePath)
  const trimmed = path.virtual.replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
  if (typeof found !== 'string')
    return Promise.resolve(new FileStat({ name, size: null, type: FileType.DIRECTORY }))
  const data = ENC.encode(found)
  // The fingerprint is the content's own hash: the stable identity a
  // snapshot records for every read and a load checks for drift.
  const fingerprint = createHash('sha256').update(data).digest('hex').slice(0, 16)
  return Promise.resolve(new FileStat({ name, size: data.length, type: FileType.FILE, content: ContentType.TEXT, fingerprint }))
}

function write(accessor: WikiAccessor, path: PathSpec, data: Uint8Array): Promise<void> {
  const parts = path.resourcePath.split('/').filter((p) => p !== '')
  const name = parts.pop() ?? ''
  let current: Tree = accessor.pages
  for (const part of parts) {
    const next = (current[part] ??= {})
    if (typeof next === 'string') throw enotdir(path)
    current = next
  }
  current[name] = DEC.decode(data)
  return Promise.resolve()
}

// Optional: a bespoke domain verb, registered alongside the generics.
const wikiTitles = command({
  name: 'wiki_titles',
  resource: 'wiki',
  spec: new CommandSpec(),
  fn: (accessor) => {
    const pages = (accessor as WikiAccessor).pages
    const titles = ['guides/quickstart.md', 'guides/deploy.md'].flatMap((page) =>
      String(node(pages, page))
        .split('\n')
        .filter((line) => line.startsWith('# '))
        .map((line) => line.slice(2)),
    )
    return [ENC.encode(`${titles.join('\n')}\n`), new IOResult()]
  },
})

function makeIO(): CommandIO<WikiAccessor> {
  return {
    readdir,
    readBytes,
    readStream: (a, p, i) => streamFromBytes(readBytes, a, p, i),
    stat,
    write,
    isMounted: () => true,
    local: false,
  }
}

class WikiResource extends GenericResource<WikiAccessor> {
  readonly wiki: WikiAccessor

  constructor(pages: Tree = PAGES) {
    // A copy, so a live workspace and one loaded from its snapshot never
    // share pages.
    const wiki = new WikiAccessor(structuredClone(pages))
    super({
      name: 'wiki',
      accessor: wiki,
      io: makeIO(),
      prompt: 'A team wiki rendered as markdown files.',
      commands: wikiTitles,
      supportsSnapshot: true,
    })
    this.wiki = wiki
  }

  // The pages are this resource's own content, not a remote backend's,
  // so they ride its state: a snapshot or a version rebuilds the mount
  // with them and nothing has to be handed back by hand. A backend over
  // a remote service keeps the default state instead and is only
  // observed, through the fingerprints its stat reports.
  override getState(): { type: string; pages: Tree } {
    return { type: this.kind, pages: structuredClone(this.wiki.pages) }
  }

  // Typed against the saved shape the loader hands back (`type` plus
  // whatever getState wrote), which is what makes the class a Resource.
  override loadState(state: { type: string; pages?: Tree }): void {
    this.wiki.pages = structuredClone(state.pages ?? {})
  }
}

// The other half of the design: content that lives in a remote service.
// This object stands in for that service. The resource holds no copy of
// it and keeps the default state, which says the mount has to be handed
// back live, so a snapshot pins what it read (through the fingerprints
// stat reports) and a load without the live resource is refused rather
// than answered with an empty mount. Nothing registers it: a mount that
// is handed back needs no name in any registry.
const FEED: Tree = { 'status.md': 'All systems go.\n' }

class FeedResource extends GenericResource<WikiAccessor> {
  constructor() {
    super({
      name: 'feed',
      accessor: new WikiAccessor(FEED),
      io: makeIO(),
      prompt: 'A status feed rendered as markdown.',
      supportsSnapshot: true,
    })
  }
}

async function show(ws: Workspace, line: string, prompt = '$'): Promise<void> {
  const io = await ws.execute(line)
  const out = io.exitCode === 0 ? io.stdoutText : `${io.stderrText}exit ${String(io.exitCode)}\n`
  console.log(`${prompt} ${line}\n${out}`)
}

async function main(): Promise<void> {
  // Registered up front: the name is what a snapshot rebuilds the mount
  // through, the same way workspace config names it.
  registerResourceFactory('wiki', () => Promise.resolve(new WikiResource()))
  const ws = new Workspace(
    { '/wiki/': new WikiResource(), '/feed/': new FeedResource() },
    { mode: MountMode.WRITE },
  )

  for (const line of [
    'ls /wiki/guides',
    'cat /wiki/notes.md',
    'grep -r Quickstart /wiki/',
    "find /wiki -name '*.md'",
    'wc -l /wiki/guides/quickstart.md',
    'wiki_titles',
    'cat /wiki/missing.md',
    'cat /feed/status.md',
  ]) {
    await show(ws, line)
  }

  // The pages are versioned state: write one, snapshot, change it, and
  // the workspace loaded from the snapshot serves the page as it was
  // while the live one keeps the change. The registered name rebuilds
  // /wiki/ with no override; /feed/ is only observed, so a load that does
  // not hand it back is refused, naming the mount, and never restores it
  // as an empty directory.
  await show(ws, "echo '# Runbook' > /wiki/runbook.md")
  const tar = join(mkdtempSync(join(tmpdir(), 'wiki-')), 'wiki.tar')
  await ws.snapshot(tar)
  await show(ws, "echo '# Runbook, revised' > /wiki/runbook.md")
  let refused = false
  try {
    await Workspace.load(tar)
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('/feed/')) throw err
    refused = true
    console.log('load: refused, /feed/ must be handed back live')
  }
  if (!refused) throw new Error('a load without /feed/ was not refused')
  const restored = await Workspace.load(tar, {}, { '/feed/': new FeedResource() })
  console.log('load: ok with /feed/ handed back\n')
  await show(ws, 'cat /wiki/runbook.md', 'live$')
  await show(restored, 'cat /wiki/runbook.md', 'restored$')
  await show(restored, 'cat /feed/status.md', 'restored$')

  await restored.close()
  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
