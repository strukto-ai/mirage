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
import { Accessor, NOOPAccessor } from '../accessor/base.ts'
import { RAMAccessor } from '../accessor/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { commandsFor } from '../commands/builtin/backends.ts'
import { command, type Command } from '../commands/config.ts'
import { CommandSpec, Operand } from '../commands/spec/types.ts'
import { CLISpec, type CLIInvocation } from '../commands/cli/types.ts'
import { RuntimeFiles } from '../runtime/files.ts'
import { IOResult } from '../io/types.ts'
import { ops } from '../test-utils.ts'
import { CapacityState, ContentType, FileStat, FileType, MountMode, PathSpec } from '../types.ts'
import { getTestParser, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { buildMountArgs, toStateDict } from '../workspace/snapshot/state.ts'
import { MountEntry } from '../workspace/mount/mount.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { BaseVFS, VFS_BRAND, type VFSOptions } from './base.ts'
import { RAMVFS } from './ram/ram.ts'
import { RAMStore } from './ram/store.ts'
import { vfsStateRequiresOverride } from './secrets.ts'

const ENC = new TextEncoder()

class Probe extends BaseVFS {
  override readonly name = 'probe'
}

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
  const found = node(accessor.pages, path.vfsPath)
  if (typeof found === 'string') throw new Error(`ENOTDIR: ${path.virtual}`)
  const parent = path.virtual.replace(/\/+$/, '')
  return Promise.resolve(
    Object.entries(found).map(
      ([name, child]) => `${parent}/${name}${typeof child === 'string' ? '' : '/'}`,
    ),
  )
}

function readBytes(accessor: WikiAccessor, path: PathSpec): Promise<Uint8Array> {
  const found = node(accessor.pages, path.vfsPath)
  if (typeof found !== 'string') throw new Error(`EISDIR: ${path.virtual}`)
  return Promise.resolve(ENC.encode(found))
}

function stat(accessor: WikiAccessor, path: PathSpec): Promise<FileStat> {
  const found = node(accessor.pages, path.vfsPath)
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

const wikiHello: readonly Command[] = command({
  name: 'wiki_hello',
  vfs: 'wiki',
  spec: new CommandSpec(),
  fn: () => [ENC.encode('hello custom verb\n'), new IOResult()],
})

/** A plug-in VFS over a tree of pages: the three required reads. */
class WikiVFS extends BaseVFS<WikiAccessor> {
  override readdir(path: PathSpec): Promise<string[]> {
    return readdir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    _index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await readBytes(this.accessor, path)
    return data.slice(offset, size === null ? undefined : offset + size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return stat(this.accessor, path)
  }
}

function makeVfs(extra: VFSOptions<WikiAccessor> = {}): WikiVFS {
  return new WikiVFS({ name: 'wiki', accessor: new WikiAccessor(PAGES), ...extra })
}

function leafDir(accessor: WikiAccessor, path: PathSpec): [Tree, string] {
  const parts = path.vfsPath.split('/').filter((x) => x !== '')
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
    node(accessor.pages, path.vfsPath)
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

class WritableWiki extends WikiVFS {
  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return write(this.accessor, path, data)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return exists(this.accessor, path)
  }

  override unlink(path: PathSpec): Promise<void> {
    return unlink(this.accessor, path)
  }
}

function writableVfs(): [WritableWiki, WikiAccessor] {
  const accessor = new WikiAccessor(structuredClone(PAGES))
  return [new WritableWiki({ name: 'wiki', accessor }), accessor]
}

function commandNames(vfs: BaseVFS): Set<string> {
  return new Set(commandsFor(vfs).map((rc) => rc.name))
}

const DISPATCH_OPS = ['read', 'readdir', 'stat', 'glob', 'write', 'unlink', 'mkdir', 'rename']

function served(vfs: BaseVFS): Set<string> {
  const mount = new MountEntry({ prefix: '/', vfs })
  return new Set(DISPATCH_OPS.filter((op) => mount.answers(op)))
}

/**
 * A RAM VFS over `store` that does not define `names`, as a plug-in that
 * leaves those functions out would not.
 */
function ramWithout(store: RAMStore, names: readonly string[], name = 'custom'): RAMVFS {
  class Custom extends RAMVFS {}
  for (const n of names) {
    Object.defineProperty(Custom.prototype, n, {
      value: (BaseVFS.prototype as unknown as Record<string, unknown>)[n],
    })
  }
  const vfs = new Custom()
  Object.assign(vfs, { name, store, accessor: new RAMAccessor(store) })
  return vfs
}

describe('BaseVFS contract', () => {
  it('carries the brand the loader checks', () => {
    expect(new Probe()[VFS_BRAND]).toBe(true)
  })

  it('serves nothing', () => {
    const r = new Probe()
    expect(served(r)).toEqual(new Set())
    expect(r.commands()).toEqual([])
  })

  // Required, as Python's class attribute is: a caller never branches on
  // the accessor's absence, and a subclass's `this.accessor` reads as the
  // type it was declared with.
  it('runs a driver that brings no accessor over a no-op one', () => {
    expect(new Probe().accessor).toBeInstanceOf(NOOPAccessor)
  })

  it('keeps the accessor a driver was handed', () => {
    const accessor = new WikiAccessor(PAGES)
    expect(makeVfs({ accessor }).accessor).toBe(accessor)
  })

  it('has no storage location', () => {
    expect(new Probe().storageLocation()).toBeNull()
  })

  it('reports an unknown capacity', async () => {
    expect((await new Probe().capacity()).state).toBe(CapacityState.UNKNOWN)
  })

  it('has no delta hook', () => {
    expect(new Probe().deltaHook?.()).toBeUndefined()
  })
})

describe('BaseVFS state', () => {
  // Mirrors Python `BaseVFS.get_state` / `load_state`: the base cannot
  // know a subclass's constructor, so it asks to be handed back live.
  it('getState names the VFS kind and asks to be handed back', () => {
    expect(new Probe().getState()).toEqual({ type: 'probe', needs_override: true })
  })

  it('loadState takes nothing back', () => {
    expect(new Probe().loadState({ type: 'probe' })).toBeUndefined()
  })

  // A load then demands the live VFS instead of substituting an empty
  // mount; a VFS that owns its content overrides the state to carry it.
  it('the default state asks for an override at load', () => {
    expect(vfsStateRequiresOverride(new Probe().getState())).toBe(true)
  })
})

describe('BaseVFS close', () => {
  it('closes once and stays closed', async () => {
    const r = new Probe()
    expect(r.isClosed).toBe(false)
    await r.close()
    await r.close()
    expect(r.isClosed).toBe(true)
  })
})

describe('a plug-in VFS', () => {
  it('registers the generic command set', () => {
    const names = commandNames(makeVfs())
    for (const name of ['ls', 'cat', 'grep', 'find', 'head', 'wc']) {
      expect(names).toContain(name)
    }
  })

  it('registers write commands the table cannot serve', () => {
    // Their read-only modes (`tee` with no operand, `gzip -c`) run on a
    // backend without writes; a line that writes answers ENOTSUP there.
    const names = commandNames(makeVfs())
    for (const name of ['tee', 'rm', 'gzip', 'tar']) expect(names).toContain(name)
  })

  it('suppresses a generic the backend overrides', () => {
    const names = commandNames(makeVfs({ overrides: new Set(['grep']) }))
    expect(names).not.toContain('grep')
    expect(names).toContain('rg')
  })

  it('registers extra commands beside the generics', () => {
    expect(commandNames(makeVfs({ commands: wikiHello }))).toContain('wiki_hello')
  })

  it('refuses an empty name', () => {
    expect(() => new WikiVFS({ name: '', accessor: new WikiAccessor(PAGES) })).toThrow(
      /non-empty name/,
    )
  })

  it('reports the name as its snapshot type, and asks to be handed back', () => {
    expect(makeVfs().getState()).toEqual({ type: 'wiki', needs_override: true })
  })

  it('refuses to restore rather than substituting an empty mount', async () => {
    const parser = await getTestParser()
    const ws = new Workspace({ '/wiki/': makeVfs() }, { mode: MountMode.READ, shellParser: parser })
    try {
      const state = await toStateDict(ws)
      expect(() => buildMountArgs(state)).toThrow(/must include overrides for: \/wiki\//)
      // A copy hands the live VFS straight back, so it still loads.
      expect(() => buildMountArgs(state, { '/wiki/': makeVfs() })).not.toThrow()
    } finally {
      await ws.close()
    }
  })

  it('carries the prompts', () => {
    const vfs = makeVfs({ prompt: 'wiki files', writePrompt: 'writable' })
    expect(vfs.prompt).toBe('wiki files')
    expect(vfs.writePrompt).toBe('writable')
  })

  it('resolves a glob through its readdir', async () => {
    const matches = await ops(makeVfs()).glob(
      new PathSpec({
        vfsPath: 'guides/quick*',
        virtual: '/guides/quick*',
        directory: '/guides',
        pattern: 'quick*',
        resolved: false,
      }),
    )
    expect(matches.map((m) => m.virtual)).toEqual(['/guides/quickstart.md'])
  })

  it('serves its reads at the dispatcher', () => {
    expect(served(makeVfs())).toEqual(new Set(['glob', 'read', 'readdir', 'stat']))
  })

  it('declares the FSKit and snapshot flags it was given', () => {
    const vfs = makeVfs({ sizesAlwaysKnown: true, supportsSnapshot: true })
    expect(vfs.sizesAlwaysKnown).toBe(true)
    expect(vfs.supportsSnapshot).toBe(true)
  })

  it('serves a mount end to end', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/wiki/': makeVfs({ commands: wikiHello }) },
      { mode: MountMode.READ, shellParser: parser },
    )
    try {
      expect(stdoutStr(await ws.shell('ls /wiki/guides'))).toContain('quickstart.md')
      expect(stdoutStr(await ws.shell('cat /wiki/notes.md'))).toBe('agents speak bash\n')
      expect(stdoutStr(await ws.shell('grep -r Quickstart /wiki/'))).toContain(
        '/wiki/guides/quickstart.md:# Quickstart',
      )
      const found = stdoutStr(await ws.shell("find /wiki -name '*.md'"))
      expect(found).toContain('/wiki/guides/quickstart.md')
      expect(found).toContain('/wiki/notes.md')
      expect(stdoutStr(await ws.shell('wiki_hello'))).toBe('hello custom verb\n')
      // The derived ops serve the VFS surface too, not just the commands.
      expect(await ws.readdir('/wiki/guides')).toContain('/wiki/guides/quickstart.md')
      expect(await ws.stat('/wiki/notes.md')).toMatchObject({ size: 18 })
    } finally {
      await ws.close()
    }
  })

  it('serves an optional function it defines', async () => {
    const [vfs, accessor] = writableVfs()
    const spec = new PathSpec({ vfsPath: 'new.md', virtual: '/new.md', directory: '/' })
    expect(await exists(accessor, spec)).toBe(false)
    await ops(vfs).write(spec, ENC.encode('written\n'))
    expect(await exists(accessor, spec)).toBe(true)
    expect(await ops(vfs).read(spec)).toEqual(ENC.encode('written\n'))
    await ops(vfs).unlink(spec)
    expect(await exists(accessor, spec)).toBe(false)
  })
})

describe('custom VFS capability fallbacks', () => {
  it.each(
    ['-r', '-rv', '-rf', '-d'].flatMap((flag) =>
      [MountMode.READ, MountMode.WRITE].map((mode) => ({ flag, mode })),
    ),
  )('continues removal after an unavailable directory op: $flag $mode', async ({ flag, mode }) => {
    const store = new RAMStore()
    store.dirs.add('/empty')
    store.files.set('/file', ENC.encode('keep'))
    const vfs = ramWithout(store, ['rmR', 'rmdir'])
    const ws = new Workspace({ '/custom': [vfs, mode] }, { shellParser: await getTestParser() })
    try {
      const result = await ws.shell(`rm ${flag} /custom/empty /custom/file`)
      const reason = mode === MountMode.READ ? 'Read-only file system' : 'Operation not supported'
      let expected = `rm: cannot remove '/custom/empty': ${reason}\n`
      if (mode === MountMode.READ)
        expected += "rm: cannot remove '/custom/file': Read-only file system\n"
      expect(result.exitCode).toBe(1)
      expect(new TextDecoder().decode(result.stderr)).toBe(expected)
      expect(store.dirs.has('/empty')).toBe(true)
      expect(store.files.has('/file')).toBe(mode === MountMode.READ)
      expect(stdoutStr(result)).toBe(
        flag === '-rv' && mode === MountMode.WRITE ? "removed '/custom/file'\n" : '',
      )
    } finally {
      await ws.close()
    }
  })

  it.each(['-r', '-rv', '-r --update=all', '-r -n'])(
    'copies without native copy: %s',
    async (flags) => {
      const store = new RAMStore()
      for (const dir of ['/src', '/src/empty', '/src/sub']) store.dirs.add(dir)
      store.files.set('/src/sub/file', ENC.encode('payload'))
      const vfs = ramWithout(store, ['copy', 'find'])
      const ws = new Workspace(
        { '/custom': vfs },
        { mode: MountMode.WRITE, shellParser: await getTestParser() },
      )
      try {
        const result = await ws.shell(`cp ${flags} /custom/src /custom/dst`)
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stderr)).toBe('')
        expect(store.files.get('/dst/sub/file')).toEqual(ENC.encode('payload'))
        for (const dir of ['/dst', '/dst/empty', '/dst/sub']) expect(store.dirs.has(dir)).toBe(true)
        const plain = await ws.shell('cp /custom/src/sub/file /custom/plain')
        expect(plain.exitCode).toBe(0)
        expect(store.files.get('/plain')).toEqual(ENC.encode('payload'))
      } finally {
        await ws.close()
      }
    },
  )

  it.each(
    ['-r', '-r --update=older', '-r -n', '-r --backup'].flatMap((flags) =>
      [MountMode.READ, MountMode.WRITE].map((mode) => ({ flags, mode })),
    ),
  )('leaves no directories when copy is unavailable: $flags $mode', async ({ flags, mode }) => {
    const store = new RAMStore()
    for (const dir of ['/src', '/src/empty']) store.dirs.add(dir)
    store.files.set('/src/file', ENC.encode('payload'))
    const before = new Set(store.dirs)
    const vfs = ramWithout(store, ['copy', 'write'])
    const ws = new Workspace({ '/custom': [vfs, mode] }, { shellParser: await getTestParser() })
    try {
      const result = await ws.shell(`cp ${flags} /custom/src /custom/dst`)
      const reason = mode === MountMode.READ ? 'Read-only file system' : 'Operation not supported'
      expect(result.exitCode).toBe(1)
      expect(new TextDecoder().decode(result.stderr)).toBe(
        `cp: cannot create directory '/custom/dst': ${reason}\n`,
      )
      expect(store.dirs).toEqual(before)
      expect([...store.files.keys()]).toEqual(['/src/file'])
    } finally {
      await ws.close()
    }
  })

  it.each([false, true])('builtin and custom writes obey mount mode, custom=%s', async (custom) => {
    const builtin = new RAMVFS()
    const path = new PathSpec({ virtual: '/data/a', directory: '/data', vfsPath: 'a' })
    const before = ENC.encode('before')
    await ops(builtin).write(path, before)
    const vfs = custom ? ramWithout(builtin.store, [], 'probe') : builtin
    const ws = new Workspace(
      { '/data': vfs },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    try {
      const result = await ws.shell('echo after > /data/a')
      expect(result.exitCode).not.toBe(0)
      expect(await ops(vfs).read(path)).toEqual(before)
    } finally {
      await ws.close()
      if (custom) await builtin.close()
    }
  })
})

async function readCli(inv: CLIInvocation): Promise<[Uint8Array, IOResult]> {
  const dispatch = inv.view?.dispatch
  const path = inv.paths[0]
  if (dispatch === undefined || path === undefined) throw new Error('missing CLI path entry point')
  const [data, result] = await dispatch('read', path)
  if (!(data instanceof Uint8Array)) throw new Error('expected file bytes')
  return [data, result]
}

it('serves a custom driver through CLI, namespace and runtime entry points', async () => {
  const ws = new Workspace(
    { '/wiki': makeVfs() },
    {
      mode: MountMode.WRITE,
      shellParser: await getTestParser(),
    },
  )
  ws.registerCli(
    'showpage',
    new CLISpec({
      name: 'showpage',
      positional: [new Operand({ name: 'path', type: 'path', required: true })],
      fn: readCli,
    }),
  )
  try {
    expect((await ws.shell('ln -s /wiki/notes.md /page')).exitCode).toBe(0)
    for (const line of ['cat /page', 'showpage /page']) {
      const result = await ws.shell(line)
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toBe('agents speak bash\n')
    }
    const runtime = new RuntimeFiles((op, path) => ws.dispatch(op, path))
    expect(new TextDecoder().decode(await runtime.read('/page'))).toBe('agents speak bash\n')
    expect(await runtime.stat('/page')).toMatchObject({ size: 18, isDir: false })
  } finally {
    await ws.close()
  }
})
