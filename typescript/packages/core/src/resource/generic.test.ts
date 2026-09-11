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

import { describe, expect, it } from 'vitest'
import { Accessor } from '../accessor/base.ts'
import type { CommandIO } from '../commands/builtin/generic_bind/index.ts'
import { streamFromBytes } from '../commands/builtin/utils/wrap.ts'
import { command, type RegisteredCommand } from '../commands/config.ts'
import { CommandSpec } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import type { RegisteredOp } from '../ops/registry.ts'
import { ContentType, FileStat, FileType, MountMode, PathSpec } from '../types.ts'
import { getTestParser, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { buildMountArgs, toStateDict } from '../workspace/snapshot/state.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { GenericResource, type GenericResourceOptions } from './generic.ts'

const ENC = new TextEncoder()

interface Tree {
  [name: string]: Tree | string
}

const PAGES: Tree = {
  guides: {
    'quickstart.md': '# Quickstart\nHello.\n',
  },
  'notes.md': 'agents speak bash\n',
}

class WikiAccessor extends Accessor {
  constructor(readonly pages: Tree) {
    super()
  }
}

function node(pages: Tree, key: string): Tree | string {
  let current: Tree | string = pages
  for (const part of key.split('/').filter((p) => p !== '')) {
    if (typeof current === 'string') throw new Error(`ENOENT: ${key}`)
    const child: Tree | string | undefined = current[part]
    if (child === undefined) throw new Error(`ENOENT: ${key}`)
    current = child
  }
  return current
}

function readdir(accessor: WikiAccessor, path: PathSpec): Promise<string[]> {
  const found = node(accessor.pages, path.resourcePath)
  if (typeof found === 'string') throw new Error(`ENOTDIR: ${path.virtual}`)
  const parent = path.virtual.replace(/\/+$/, '')
  return Promise.resolve(
    Object.entries(found).map(
      ([name, child]) => `${parent}/${name}${typeof child === 'string' ? '' : '/'}`,
    ),
  )
}

function readBytes(accessor: WikiAccessor, path: PathSpec): Promise<Uint8Array> {
  const found = node(accessor.pages, path.resourcePath)
  if (typeof found !== 'string') throw new Error(`EISDIR: ${path.virtual}`)
  return Promise.resolve(ENC.encode(found))
}

function stat(accessor: WikiAccessor, path: PathSpec): Promise<FileStat> {
  const found = node(accessor.pages, path.resourcePath)
  const trimmed = path.virtual.replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
  if (typeof found !== 'string')
    return Promise.resolve(new FileStat({ name, size: null, type: FileType.DIRECTORY }))
  return Promise.resolve(
    new FileStat({
      name,
      size: ENC.encode(found).length,
      type: FileType.FILE,
      content: ContentType.TEXT,
    }),
  )
}

const wikiHello: readonly RegisteredCommand[] = command({
  name: 'wiki_hello',
  resource: 'wiki',
  spec: new CommandSpec(),
  fn: () => [ENC.encode('hello custom verb\n'), new IOResult()],
})

function makeIO(): CommandIO<WikiAccessor> {
  return {
    readdir,
    readBytes,
    readStream: (a, p, i) => streamFromBytes(readBytes, a, p, i),
    stat,
    isMounted: () => true,
    local: false,
  }
}

function makeResource(
  extra: Partial<GenericResourceOptions<WikiAccessor>> = {},
): GenericResource<WikiAccessor> {
  return new GenericResource<WikiAccessor>({
    name: 'wiki',
    accessor: new WikiAccessor(PAGES),
    io: makeIO(),
    ...extra,
  })
}

function leafDir(accessor: WikiAccessor, path: PathSpec): [Tree, string] {
  const parts = path.resourcePath.split('/').filter((x) => x !== '')
  const leaf = parts.pop() ?? ''
  const dir = node(accessor.pages, parts.join('/'))
  if (typeof dir === 'string') throw new Error(`ENOTDIR: ${path.virtual}`)
  return [dir, leaf]
}

function write(accessor: WikiAccessor, path: PathSpec, data: Uint8Array): Promise<void> {
  const [dir, leaf] = leafDir(accessor, path)
  dir[leaf] = new TextDecoder().decode(data)
  return Promise.resolve()
}

function exists(accessor: WikiAccessor, path: PathSpec): Promise<boolean> {
  try {
    node(accessor.pages, path.resourcePath)
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(false)
  }
}

function unlink(accessor: WikiAccessor, path: PathSpec): Promise<void> {
  const [dir, leaf] = leafDir(accessor, path)
  Reflect.deleteProperty(dir, leaf)
  return Promise.resolve()
}

function writableResource(): GenericResource<WikiAccessor> {
  return new GenericResource<WikiAccessor>({
    name: 'wiki',
    accessor: new WikiAccessor(structuredClone(PAGES)),
    io: { ...makeIO(), write, exists, unlink },
  })
}

function commandNames(resource: GenericResource<WikiAccessor>): Set<string> {
  return new Set(resource.commands().map((rc) => rc.name))
}

describe('GenericResource wires a backend from one CommandIO table', () => {
  it('registers the generic command set', () => {
    const names = commandNames(makeResource())
    for (const name of ['ls', 'cat', 'grep', 'find', 'head', 'wc']) {
      expect(names).toContain(name)
    }
  })

  it('leaves out write commands the table cannot serve', () => {
    const names = commandNames(makeResource())
    expect(names).not.toContain('tee')
    expect(names).not.toContain('rm')
  })

  it('suppresses a generic the backend overrides', () => {
    const names = commandNames(makeResource({ overrides: new Set(['grep']) }))
    expect(names).not.toContain('grep')
    expect(names).toContain('rg')
  })

  it('registers extra commands beside the generics', () => {
    expect(commandNames(makeResource({ commands: wikiHello }))).toContain('wiki_hello')
  })

  it('refuses an empty name', () => {
    expect(
      () => new GenericResource({ name: '', accessor: new WikiAccessor(PAGES), io: makeIO() }),
    ).toThrow(/non-empty name/)
  })

  it('reports the name as its snapshot type, and asks to be handed back', () => {
    expect(makeResource().getState()).toEqual({ type: 'wiki', needs_override: true })
  })

  it('refuses to restore rather than substituting an empty mount', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/wiki/': makeResource() },
      { mode: MountMode.READ, shellParser: parser },
    )
    try {
      const state = await toStateDict(ws)
      expect(() => buildMountArgs(state)).toThrow(/must include overrides for: \/wiki\//)
      // A copy hands the live resource straight back, so it still loads.
      expect(() => buildMountArgs(state, { '/wiki/': makeResource() })).not.toThrow()
    } finally {
      await ws.close()
    }
  })

  it('carries the prompts', () => {
    const resource = makeResource({ prompt: 'wiki files', writePrompt: 'writable' })
    expect(resource.prompt).toBe('wiki files')
    expect(resource.writePrompt).toBe('writable')
  })

  it('resolves a glob through the table readdir', async () => {
    const matches = await makeResource().glob([
      new PathSpec({
        resourcePath: 'guides/quick*',
        virtual: '/guides/quick*',
        directory: '/guides',
        pattern: 'quick*',
        resolved: false,
      }),
    ])
    expect(matches.map((m) => m.virtual)).toEqual(['/guides/quickstart.md'])
  })

  it('derives the op set from the table', () => {
    const derived = new Set(
      makeResource()
        .ops()
        .map((ro) => `${ro.name}:${String(ro.write)}`),
    )
    expect(derived).toEqual(new Set(['read:false', 'readdir:false', 'stat:false']))
  })

  it('registers no ops when autoOps is off', () => {
    expect(makeResource({ autoOps: false }).ops()).toEqual([])
  })

  it('lets a user op shadow the derived one of the same name', () => {
    const myRead: RegisteredOp = {
      name: 'read',
      resource: 'wiki',
      filetype: null,
      fn: () => ENC.encode('custom'),
      write: false,
    }
    const reads = makeResource({ ops: [myRead] })
      .ops()
      .filter((ro) => ro.name === 'read')
    expect(reads).toHaveLength(1)
    expect(reads[0]?.fn).toBe(myRead.fn)
  })

  it('declares the FSKit and snapshot flags it was given', () => {
    const resource = makeResource({ sizesAlwaysKnown: true, supportsSnapshot: true })
    expect(resource.sizesAlwaysKnown).toBe(true)
    expect(resource.supportsSnapshot).toBe(true)
  })

  it('serves a mount end to end', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/wiki/': makeResource({ commands: wikiHello }) },
      { mode: MountMode.READ, shellParser: parser },
    )
    try {
      expect(stdoutStr(await ws.execute('ls /wiki/guides'))).toContain('quickstart.md')
      expect(stdoutStr(await ws.execute('cat /wiki/notes.md'))).toBe('agents speak bash\n')
      expect(stdoutStr(await ws.execute('grep -r Quickstart /wiki/'))).toContain(
        '/wiki/guides/quickstart.md:# Quickstart',
      )
      const found = stdoutStr(await ws.execute("find /wiki -name '*.md'"))
      expect(found).toContain('/wiki/guides/quickstart.md')
      expect(found).toContain('/wiki/notes.md')
      expect(stdoutStr(await ws.execute('wiki_hello'))).toBe('hello custom verb\n')
      // The derived ops serve the VFS surface too, not just the commands.
      expect(await ws.readdir('/wiki/guides')).toContain('/wiki/guides/quickstart.md')
      expect(await ws.stat('/wiki/notes.md')).toMatchObject({ size: 18 })
    } finally {
      await ws.close()
    }
  })

  it('leaves an optional method genuinely absent, not present-and-undefined', () => {
    const resource = makeResource()
    expect(resource.writeFile).toBeUndefined()
    // `declare` emits no property, so a feature probe written either way
    // agrees. A plain optional field would answer this one true.
    expect('writeFile' in resource).toBe(false)
    expect('rmR' in resource).toBe(false)
  })

  it('always answers the four the table cannot omit', () => {
    const resource = makeResource()
    for (const name of ['readFile', 'readdir', 'stat', 'streamPath'] as const) {
      expect(typeof resource[name]).toBe('function')
    }
  })

  it('installs a forwarder for each optional field the table carries', () => {
    const resource = writableResource()
    expect(typeof resource.writeFile).toBe('function')
    expect(typeof resource.exists).toBe('function')
    expect(typeof resource.unlink).toBe('function')
    // Still absent: the table carries no mkdir, rename or du.
    expect('mkdir' in resource).toBe(false)
    expect('rename' in resource).toBe(false)
    expect('du' in resource).toBe(false)
  })

  it('forwards an optional call through to the table', async () => {
    const resource = writableResource()
    const spec = new PathSpec({ resourcePath: 'new.md', virtual: '/new.md', directory: '/' })
    expect(await resource.exists?.(spec)).toBe(false)
    await resource.writeFile?.(spec, ENC.encode('written\n'))
    expect(await resource.exists?.(spec)).toBe(true)
    expect(await resource.readFile(spec)).toEqual(ENC.encode('written\n'))
    await resource.unlink?.(spec)
    expect(await resource.exists?.(spec)).toBe(false)
  })
})
