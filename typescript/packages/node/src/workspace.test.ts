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

import { chmodSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode, PathSpec, ReadPolicy, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { DiskAccessor } from './accessor/disk.ts'
import { DiskEventHook } from './core/disk/watch/hook.ts'
import { DiskVFS } from './vfs/disk/disk.ts'
import { InlineGitHub } from './vfs/fixtures/github.ts'
import { buildVfs } from './vfs/registry.ts'
import { conditionalS3, s3Vfs, tmpRoot } from './test-utils.ts'
import { Workspace } from './workspace.ts'

describe('@struktoai/mirage-node Workspace', () => {
  it('lazy-loads the shell parser via readFileSync(require.resolve(...)) on first execute()', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const res = await ws.shell('echo hi')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('hi\n')
    await ws.close()
  })

  it('reuses the cached parser across multiple execute() calls', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const r1 = await ws.shell('echo one')
    const r2 = await ws.shell('echo two')
    expect(new TextDecoder().decode(r1.stdout)).toBe('one\n')
    expect(new TextDecoder().decode(r2.stdout)).toBe('two\n')
    await ws.close()
  })

  it('respects an explicitly provided shellParserFactory', async () => {
    let calls = 0
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => {
          calls += 1
          const { createShellParser } = await import('@struktoai/mirage-core/shell/parse')
          const { readFileSync } = await import('node:fs')
          const { createRequire } = await import('node:module')
          const requireCjs = createRequire(import.meta.url)
          return createShellParser({
            engineWasm: readFileSync(requireCjs.resolve('web-tree-sitter/web-tree-sitter.wasm')),
            grammarWasm: readFileSync(requireCjs.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
          })
        },
      },
    )
    await ws.shell('echo a')
    await ws.shell('echo b')
    expect(calls).toBe(1)
    await ws.close()
  })

  it.each([
    ['-maxdepth abc', "find: invalid argument 'abc' to '-maxdepth'"],
    ['-mindepth xx', "find: invalid argument 'xx' to '-mindepth'"],
    ["-size ''", 'find: invalid null argument to -size'],
    ['-size abc', "find: Invalid argument `abc' to -size"],
    ['-mtime abc', "find: invalid argument 'abc' to '-mtime'"],
  ])('find %s exits 1 with a clean stderr instead of crashing', async (expr, message) => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const res = await ws.shell(`find / ${expr}`)
    expect(res.exitCode).toBe(1)
    expect(new TextDecoder().decode(res.stderr)).toBe(`${message}\n`)
    await ws.close()
  })

  it.each([
    ["echo a '' b", 'a  b\n'],
    ['echo a "" b', 'a  b\n'],
  ])('keeps a quoted empty string as a real argument: %s', async (cmd, expected) => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const res = await ws.shell(cmd)
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe(expected)
    await ws.close()
  })
})

describe('@struktoai/mirage-node Workspace disk metadata', () => {
  function makeDiskWs(): { ws: Workspace; root: string; cleanup: () => void } {
    const { root, cleanup } = tmpRoot('mirage-node-meta-')
    writeFileSync(join(root, 'f.txt'), 'hello')
    const ws = new Workspace(
      { '/data': [new DiskVFS({ root }), MountMode.WRITE] },
      { mode: MountMode.WRITE },
    )
    return { ws, root, cleanup }
  }

  it('chmod 000 shows zero in ls -l but keeps owner access', async () => {
    const { ws, root, cleanup } = makeDiskWs()
    const c = await ws.shell('chmod 000 /data/f.txt')
    expect(c.exitCode).toBe(0)
    const ls = await ws.shell('ls -l /data')
    expect(ls.stdoutText).toContain('----------')
    expect(statSync(join(root, 'f.txt')).mode & 0o777).toBe(0o600)
    const cat = await ws.shell('cat /data/f.txt')
    expect(cat.exitCode).toBe(0)
    expect(cat.stdoutText).toBe('hello')
    await ws.close()
    cleanup()
  })

  it('relaxing chmod drops the stale residual overlay', async () => {
    const { ws, cleanup } = makeDiskWs()
    await ws.shell('chmod 000 /data/f.txt')
    await ws.shell('chmod 644 /data/f.txt')
    const st = (await ws.dispatch('stat', '/data/f.txt')) as { mode: number }
    expect(st.mode).toBe(0o644)
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.close()
    cleanup()
  })

  it('shows an external chmod in ls -l', async () => {
    const { ws, root, cleanup } = makeDiskWs()
    chmodSync(join(root, 'f.txt'), 0o640)
    const ls = await ws.shell('ls -l /data')
    expect(ls.stdoutText).toContain('-rw-r-----')
    await ws.close()
    cleanup()
  })

  it('overlays chown and renders owner/group in ls -l', async () => {
    const { ws, cleanup } = makeDiskWs()
    const c = await ws.shell('chown 500:dev /data/f.txt')
    expect(c.exitCode).toBe(0)
    const ls = await ws.shell('ls -l /data')
    expect(ls.stdoutText).toContain(' 500 dev ')
    await ws.close()
    cleanup()
  })
})

// A fresh github mount lists the tree once, then pays one check of the head
// per command while nothing changes, and one check plus one walk after a
// change outside mirage.
it('checks a fresh github mount by its head once per command', async () => {
  const gh = new InlineGitHub({ 'docs/a.txt': 'a\n', 'docs/b.txt': 'b\n' })
  vi.stubGlobal('fetch', gh.fetch)
  const vfs = await buildVfs('github', {
    token: 't',
    owner: 'o',
    repo: 'r',
    ref: 'main',
    base_url: gh.url,
  })
  const ws = new Workspace({
    '/gh': new Mount(vfs, { mode: MountMode.READ, read: { policy: ReadPolicy.FRESH, ttl: 600 } }),
  })
  const ls = async (): Promise<[string, number[]]> => {
    gh.log.length = 0
    const result = await ws.shell('ls /gh/docs')
    expect([result.exitCode, new TextDecoder().decode(result.stderr)]).toEqual([0, ''])
    return [
      new TextDecoder().decode(result.stdout),
      [gh.count('dir'), gh.count('recursive'), gh.count('blob')],
    ]
  }
  try {
    gh.log.length = 0
    expect(await ls()).toEqual(['a.txt\nb.txt\n', [0, 1, 0]])
    expect(await ls()).toEqual(['a.txt\nb.txt\n', [1, 0, 0]])
    gh.set('docs/c.txt', 'c\n')
    expect(await ls()).toEqual(['a.txt\nb.txt\nc.txt\n', [1, 1, 0]])
  } finally {
    vi.unstubAllGlobals()
    await ws.close()
  }
})

describe('a host folder removal reported by the disk watcher', () => {
  const decoder = new TextDecoder()
  let root: string
  let ws: Workspace

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mirage-watch-push-'))
    ws = new Workspace({ '/d': new DiskVFS({ root }) }, { mode: MountMode.READ })
  })

  afterEach(async () => {
    await ws.close()
    await rm(root, { recursive: true, force: true })
  })

  it('leaves nothing listed after a host rm -r reported children first', async () => {
    // A host `rm -r` arrives as one `deleted` per path, children first; each
    // level's listing is gone by the time its own event arrives, except an
    // empty folder's, which only its own event clears.
    await mkdir(join(root, 'day', 'sub'), { recursive: true })
    await mkdir(join(root, 'day', 'empty'))
    await writeFile(join(root, 'day', 'sub', 'a.txt'), 'a')
    await writeFile(join(root, 'day', 'b.txt'), 'b')
    expect(decoder.decode((await ws.shell('ls /d/day/sub')).stdout)).toContain('a.txt')
    expect((await ws.shell('ls /d/day/empty')).exitCode).toBe(0)
    expect(decoder.decode((await ws.shell('ls /d/day')).stdout)).toContain('b.txt')

    const removed = [
      join(root, 'day', 'sub', 'a.txt'),
      join(root, 'day', 'sub'),
      join(root, 'day', 'empty'),
      join(root, 'day', 'b.txt'),
      join(root, 'day'),
    ]
    await rm(join(root, 'day'), { recursive: true, force: true })
    const hook = new DiskEventHook(new DiskAccessor(root))
    const mountRoot = new PathSpec({ virtual: '/d', directory: '/d', vfsPath: '' })
    for (const removedPath of removed) {
      for (const change of await hook.toEvents(mountRoot, 'deleted', { src_path: removedPath })) {
        await ws.notify(change)
      }
    }

    expect((await ws.shell('ls /d/day/sub')).exitCode).not.toBe(0)
    expect((await ws.shell('ls /d/day/empty')).exitCode).not.toBe(0)
    expect((await ws.shell('ls /d/day')).exitCode).not.toBe(0)
  })
})

describe('the write policy at the workspace entry points', () => {
  const built: Workspace[] = []
  function track(ws: Workspace): Workspace {
    built.push(ws)
    return ws
  }
  afterEach(async () => {
    for (const ws of built.splice(0).reverse()) await ws.close()
  })

  it.each([
    ['names', {}, s3Vfs, 'conditional', WritePolicy.CONDITIONAL],
    ['cannot honour', {}, () => new RAMVFS(), 'conditional', 'ram does not'],
    ['inherits', { write: WritePolicy.CONDITIONAL }, s3Vfs, undefined, WritePolicy.CONDITIONAL],
    ['inherits on null', { write: WritePolicy.CONDITIONAL }, s3Vfs, null, WritePolicy.CONDITIONAL],
    ['keeps nothing', { cacheLimit: 0 }, s3Vfs, 'conditional', 'caches reads'],
  ] as const)(
    'judges an added mount on its write policy: %s',
    (_name, options, vfs, write, expected) => {
      // The wire string, not the enum: the programmatic entry point coerces first.
      const ws = track(new Workspace({}, { mode: MountMode.WRITE, ...options }))
      const add = () => ws.addMount('/m', vfs(), MountMode.WRITE, undefined, null, undefined, write)
      if (expected === WritePolicy.CONDITIONAL) expect(add().write).toBe(expected)
      else expect(add).toThrow(expected)
    },
  )

  it('keeps the host-built mounts unconditional under a conditional default', async () => {
    const ws = track(
      new Workspace({ '/s3': s3Vfs() }, { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL }),
    )
    expect(ws.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
    for (const prefix of ['/dev/', '/', '/.bash_history/', '/usr/bin/']) {
      expect(ws.mount(prefix).write, prefix).toBe(WritePolicy.UNCONDITIONAL)
    }
    expect((await ws.shell('echo x > /dev/null')).exitCode).toBe(0)
  })

  it('refuses a conditional mount when the cache keeps nothing', () => {
    // A zero cache limit keeps nothing, so no write would have a version.
    expect(() => new Workspace({ '/s3': conditionalS3() }, { cacheLimit: 0 })).toThrow(
      'caches reads',
    )
  })
})
