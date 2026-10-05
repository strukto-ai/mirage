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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { createShellParser } from '../shell/parse/index.ts'
import { ops } from '../test-utils.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { DEFAULT_READ_TTL, MountMode, PathSpec, ReadPolicy } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'
import { IOResult } from '../io/types.ts'
import { Mount } from './mount/spec.ts'
import type { Dispatcher } from './dispatcher/dispatcher.ts'

function boundOf(ws: Workspace, key: string): number | null | undefined {
  const store = ws.cache as unknown as {
    snapshotEntries(): { key: string; entry: { ttl: number | null } }[]
  }
  return store.snapshotEntries().find((e) => e.key === key)?.entry.ttl
}

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

describe('cache is a hidden store, not a mount', () => {
  it('is decoupled from the root mount', async () => {
    // The file cache is reached via `registry.fileCache`, not the root mount's
    // VFS. When no `/` is mounted the root is an ordinary empty RAM mount
    // at `/` (a normal entry in allMounts) and never holds the cache.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      expect(ws.registry.fileCache).toBe(ws.cache)
      const root = ws.registry.rootMount
      expect(root).not.toBeNull()
      expect(root?.vfs).not.toBe(ws.cache)
      expect((root?.vfs ?? new RAMVFS()).cachesReads).toBe(false)
      expect(root?.prefix).toBe('/')
      expect(ws.registry.allMounts()).toContain(root)
    } finally {
      await ws.close()
    }
  })

  it('reuses a user-provided / mount as the root anchor (no synthetic root)', async () => {
    const userRoot = new RAMVFS()
    const ws = new Workspace({ '/': userRoot }, { mode: MountMode.WRITE })
    try {
      expect(ws.registry.rootMount?.vfs).toBe(userRoot)
      expect(ws.registry.fileCache).toBe(ws.cache)
    } finally {
      await ws.close()
    }
  })
})

describe('warm read serves from the hidden store, command stays on its mount', () => {
  it('serves a cached operand under bounded after out-of-band mutation', async () => {
    const ram = new RAMVFS()
    // Force the cache on a local backend so the read is cached and, under `bounded`,
    // never revalidated. A subsequent out-of-band mutation must NOT be seen:
    // the warm read serves the cached bytes from the hidden store while the
    // command stays on its real mount.
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ops(ram).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      const first = DEC.decode((await ws.shell('cat /r/a.txt')).stdout)
      expect(first).toContain('v1')
      await ops(ram).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
      const second = DEC.decode((await ws.shell('cat /r/a.txt')).stdout)
      expect(second).toContain('v1')
      expect(second).not.toContain('v2')
    } finally {
      await ws.close()
    }
  })
})

describe('the mount bound reaches the cache through a shell read', () => {
  it('stamps a per-mount ttl on the entry a cold read fills', async () => {
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: 45 },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ops(ram).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      await ws.shell('cat /r/a.txt')
      const store = ws.cache as unknown as {
        snapshotEntries(): { key: string; entry: { ttl: number | null } }[]
      }
      // The value the mount declared, not merely "some bound". A stamp
      // that hardcoded the default would leave `isUnbounded` false and
      // make a per-mount `ttl:` cosmetic.
      expect(store.snapshotEntries().find((e) => e.key === '/r/a.txt')?.entry.ttl).toBe(45)
    } finally {
      await ws.close()
    }
  })

  // The headline claim: the bound is per mount, not per workspace. Every
  // other stamping test declares one workspace-level bound, so the
  // mount's value and the default are the same number and a stamp that
  // read `registry.defaultRead.ttl` would pass them all.
  it('stamps each mount its own bound, not the workspace default', async () => {
    const fast = new RAMVFS()
    const slow = new RAMVFS()
    for (const vfs of [fast, slow]) {
      ;(vfs as unknown as { cachesReads: boolean }).cachesReads = true
    }
    const ws = new Workspace(
      {
        '/fast': new Mount(fast, {
          mode: MountMode.WRITE,
          read: { policy: ReadPolicy.BOUNDED, ttl: 30 },
        }),
        '/slow': new Mount(slow, {
          mode: MountMode.WRITE,
          read: { policy: ReadPolicy.BOUNDED, ttl: 90 },
        }),
      },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ops(fast).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      await ops(slow).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      await ws.shell('cat /fast/a.txt')
      await ws.shell('cat /slow/a.txt')
      expect(boundOf(ws, '/fast/a.txt')).toBe(30)
      expect(boundOf(ws, '/slow/a.txt')).toBe(90)
    } finally {
      await ws.close()
    }
  })

  // `applyIo` with no captured function is the embedder's door
  // (`cacheFactsFor`, resolved live). Only `captureCacheFacts`, reached
  // through a shell line, is exercised by the tests above.
  it('reads the mount bound at the live cache-facts door too', async () => {
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      {
        '/r': new Mount(ram, {
          mode: MountMode.WRITE,
          read: { policy: ReadPolicy.BOUNDED, ttl: 45 },
        }),
      },
      { mode: MountMode.WRITE },
    )
    try {
      // `dispatcher` is private; the embedder reaches this door through
      // `applyIo`, which defaults to `cacheFactsFor`.
      const disp = (ws as unknown as { dispatcher: Dispatcher }).dispatcher
      await disp.applyIo(
        new IOResult({ reads: { '/r/f.txt': ENC.encode('x') }, cache: ['/r/f.txt'] }),
      )
      expect(boundOf(ws, '/r/f.txt')).toBe(45)
      expect(disp.cacheFactsFor('/nowhere/f.txt').cacheable).toBe(false)
    } finally {
      await ws.close()
    }
  })

  // The self-heal, end to end: an entry written before the bound existed
  // is dropped on the next read and refilled with one. Only refusing to
  // serve it would refetch forever without ever stamping.
  it('drops and re-stamps a bound-less entry on the next read', async () => {
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: 45 },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ops(ram).write(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      // The same bytes the backend holds: that is what an entry written
      // before bounds existed looks like, and it is the case where a
      // refusal alone cannot heal, because the refill short-circuits on
      // equal bytes rather than re-setting.
      await ws.cache.set('/r/a.txt', ENC.encode('v1\n'))
      expect(await ws.cache.isUnbounded('/r/a.txt')).toBe(true)

      expect(DEC.decode((await ws.shell('cat /r/a.txt')).stdout)).toContain('v1')
      expect(await ws.cache.isUnbounded('/r/a.txt')).toBe(false)
    } finally {
      await ws.close()
    }
  })
})

describe('namespace orphan GC on remote delete', () => {
  it('GCs an orphaned overlay when a stat reports the path gone under fresh', async () => {
    // The subject is the reaction, not RAM: the instance declares the two
    // capabilities the verdict asks for so a RAM mount can legally carry
    // the policy.
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true, readRevalidatable: true })
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL } },
    )
    try {
      await ws.namespace.ensureLoaded()
      await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
      expect(ws.namespace.metaFor('/data/gone.txt')).not.toBeNull()
      await expect(ws.dispatch('stat', '/data/gone.txt')).rejects.toThrow()
      expect(ws.namespace.metaFor('/data/gone.txt')).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('a single-mount shell stat GCs an orphaned overlay under fresh', async () => {
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true, readRevalidatable: true })
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ws.namespace.ensureLoaded()
      await ws.namespace.setAttrs('/r/gone.txt', { mode: 0o600 })
      expect(ws.namespace.metaFor('/r/gone.txt')).not.toBeNull()
      await ws.shell('stat /r/gone.txt')
      expect(ws.namespace.metaFor('/r/gone.txt')).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('leaves the overlay in place under bounded', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL } },
    )
    try {
      await ws.namespace.ensureLoaded()
      await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
      await expect(ws.dispatch('stat', '/data/gone.txt')).rejects.toThrow()
      expect(ws.namespace.metaFor('/data/gone.txt')).not.toBeNull()
    } finally {
      await ws.close()
    }
  })
})

describe('a guarded cp reads past the cache without refilling it', () => {
  it('leaves the entry it read past under bounded', async () => {
    // Every condition here is load-bearing and fails silently if changed.
    // The hide forces `cp` onto the primitive walk, whose per-file read
    // carries no backend token; the native strategy fills no cache at all.
    // The mount is the root because `cp` keys its reads on `src.virtual`
    // while the runner re-prefixes, so at `/r` the fill lands on
    // `/r/r/dir/a.txt` and this asserts nothing (#441, #629).
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      ws.createSession('agent', { profile: { paths: { hide: ['/dir/.secret'] } } })
      await ops(ram).mkdir(PathSpec.fromStrPath('/dir'), true)
      await ops(ram).write(PathSpec.fromStrPath('/dir/a.txt'), ENC.encode('v1\n'))
      const cold = await ws.shell('cat /dir/a.txt', { sessionId: 'agent' })
      expect(DEC.decode(cold.stdout)).toBe('v1\n')

      await ops(ram).write(PathSpec.fromStrPath('/dir/a.txt'), ENC.encode('v2\n'))
      const copied = await ws.shell('cp -r /dir /copy', { sessionId: 'agent' })
      expect(copied.exitCode).toBe(0)

      const made = await ws.shell('cat /copy/a.txt', { sessionId: 'agent' })
      expect(DEC.decode(made.stdout)).toBe('v2\n')
      const served = await ws.shell('cat /dir/a.txt', { sessionId: 'agent' })
      expect(DEC.decode(served.stdout)).toBe('v1\n')
    } finally {
      await ws.close()
    }
  })
})

describe('a renderer registered beside the VFS', () => {
  // Commands fill the cache with what their own reads return, which a
  // renderer registered beside the VFS never sees.
  it.each([
    ['cat', 'cat /data/books.tally'],
    ['tee', 'echo T | tee /data/books.tally'],
  ])('still renders after a shell %s fills the cache', async (_name, line) => {
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true })
    const registry = new OpsRegistry()
    registry.registerVfs(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    registry.register({
      name: 'read',
      vfs: ram.name,
      filetype: '.tally',
      write: false,
      fn: () => Promise.resolve(ENC.encode('RENDERED')),
    })
    try {
      await ops(ram).write(PathSpec.fromStrPath('/books.tally'), ENC.encode('STORED\n'))
      const result = await ws.shell(line)
      expect(result.exitCode).toBe(0)
      expect(await ws.cache.exists('/data/books.tally')).toBe(true)
      expect(await ws.vfs.cat('/data/books.tally')).toBe('RENDERED')
    } finally {
      await ws.close()
    }
  })

  // A relay reads through the dispatcher, so it reads the rendering; kept
  // under the path, it is what cat would print.
  it.each([
    ['cp', 'cp /data/books.tally /other/copy && cat /other/copy'],
    ['sed', 'sed -n p /data/books.tally /other/notes'],
    ['diff', 'diff /data/books.tally /other/notes'],
  ])('a cross-mount %s never keeps the rendering', async (_name, line) => {
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true })
    const other = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(ram)
    registry.registerVfs(other)
    const ws = new Workspace(
      { '/data': ram, '/other': other },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    registry.register({
      name: 'read',
      vfs: ram.name,
      filetype: '.tally',
      write: false,
      fn: () => Promise.resolve(ENC.encode('RENDERED')),
    })
    try {
      await ops(ram).write(PathSpec.fromStrPath('/books.tally'), ENC.encode('STORED\n'))
      await ops(other).write(PathSpec.fromStrPath('/notes'), ENC.encode('N\n'))
      expect(DEC.decode((await ws.shell(line)).stdout)).toContain('RENDERED')
      expect(await ws.cache.exists('/data/books.tally')).toBe(false)
      expect(DEC.decode((await ws.shell('cat /data/books.tally')).stdout)).toBe('STORED\n')
    } finally {
      await ws.close()
    }
  })
})

describe('a line touching a file twice', () => {
  it.each([
    ["cat /d/f; printf 'z\\n' >> /d/f", null, 'b\na\nz\n'],
    ['awk 1 /d/f | tee -a /d/f > /dev/null', null, 'b\na\nb\na\n'],
    ["sort -o /d/f /d/f; printf 'z\\n' >> /d/f", null, 'a\nb\nz\n'],
    ["printf 'q\\n' | tee /d/f >> /d/f", null, 'q\nq\n'],
    ["printf 'q\\n' | tee /d/f >> /d/f 2>> /d/f", null, 'q\nq\n'],
    ['cat /d/f; sort -o /d/f /d/f', 'a\nb\n', 'a\nb\n'],
    ['cat /d/f | sort -o /d/f', 'a\nb\n', 'a\nb\n'],
  ])('%s caches %j', async (line, cached, stored) => {
    // An append, or a read before a write, leaves no entry; a whole write
    // after a read is kept. Mirrors Python's
    // test_a_line_touching_a_file_twice_caches_only_a_whole_file.
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/d': ram },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ws.shell("printf 'b\\na\\n' > /d/f")
      await ws.shell('cat /d/f')
      await ws.shell(line)
      const entry = await ws.cache.get('/d/f')
      expect(entry === null ? null : DEC.decode(entry)).toBe(cached)
      expect(DEC.decode((await ws.shell('cat /d/f')).stdout)).toBe(stored)
    } finally {
      await ws.close()
    }
  })
})

describe('a read given up on', () => {
  it.each([
    [true, "cat /d/big | head -c 1; printf 'z\\n' >> /d/big"],
    [false, 'cat /d/big | head -c 1'],
  ])(
    'leaves the mount free to unmount (caching %s): %s',
    async (caching, line) => {
      // A read the line gave up on is closed, or unmount waits on it. Mirrors
      // Python's test_a_read_given_up_on_leaves_the_mount_free_to_unmount.
      const ram = new RAMVFS()
      ;(ram as unknown as { cachesReads: boolean }).cachesReads = caching
      const ws = new Workspace(
        { '/d': ram },
        {
          mode: MountMode.WRITE,
          shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
        },
      )
      try {
        await ws.shell('seq 1 200000 > /d/big')
        await ws.shell(line)
        let timer: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([
          ws.unmount('/d').then(() => 'unmounted'),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => {
              resolve('still busy')
            }, 10000)
          }),
        ])
        clearTimeout(timer)
        expect(outcome).toBe('unmounted')
      } finally {
        await ws.close()
      }
    },
    20000,
  )
})

// RAM serves reads itself and keeps no file cache by default, which would
// make every body assertion below hold vacuously.
class CachingRAMVFS extends RAMVFS {
  override readonly cachesReads: boolean = true
}

// Record every prefix walk of the file cache and the mount's index.
function countDrops(ws: Workspace, path: string): string[] {
  const drops: string[] = []
  const cache = ws.cache
  const mount = ws.registry.tryMountFor(path)
  if (mount === null) throw new Error(`no mount for ${path}`)
  const index = mount.indexStore
  const realEvict = cache.evictPrefix.bind(cache)
  const realInvalidate = index.invalidatePrefix.bind(index)
  cache.evictPrefix = (prefix, excluded) => {
    drops.push(`body:${prefix}`)
    return realEvict(prefix, excluded)
  }
  index.invalidatePrefix = (key, excluded) => {
    drops.push(`index:${key}`)
    return realInvalidate(key, excluded)
  }
  return drops
}

describe('mv and the caches', () => {
  it('mv of a file keeps every other cached read', async () => {
    // `mv` of a plain file has nothing beneath it, so the backend's rename
    // walks neither store, and the warm read of another folder survives. A
    // folder `mv` still takes its subtree under the old name.
    const ws = new Workspace(
      { '/m/': new CachingRAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    const dec = new TextDecoder()
    try {
      await ws.shell('echo f > /m/f && mkdir /m/dir && echo x > /m/dir/x')
      await ws.shell('cat /m/dir/x')
      expect(await ws.cache.exists('/m/dir/x')).toBe(true)
      const drops = countDrops(ws, '/m/f')
      await ws.shell('mv /m/f /m/g')
      // The spies are what tell narrowed from not: a file has nothing cached
      // beneath it, so the old subtree drop removed no body either. The warm
      // read surviving guards the other way, against a drop wider than /m/f.
      expect(drops).toEqual([])
      expect(await ws.cache.exists('/m/dir/x')).toBe(true)
      expect(dec.decode((await ws.shell('cat /m/g')).stdout)).toBe('f\n')
      await ws.shell('mv /m/dir /m/dir2')
      expect(await ws.cache.exists('/m/dir/x')).toBe(false)
      expect((await ws.shell('cat /m/dir/x')).exitCode).not.toBe(0)
      expect(dec.decode((await ws.shell('cat /m/dir2/x')).stdout)).toBe('x\n')
    } finally {
      await ws.close()
    }
  })
})
