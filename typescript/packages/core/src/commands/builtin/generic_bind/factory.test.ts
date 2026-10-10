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

import { materialize } from '../../../io/types.ts'

import { describe, expect, it } from 'vitest'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { requireOp } from './adapter.ts'
import type { CommandIO } from '../../config.ts'
import { BUILDERS } from './builders/index.ts'
import {
  GENERIC_COMMANDS,
  generic,
  scanIo,
  walked,
  withProbeAnswers,
  withSlashGuard,
  withStatCache,
} from './factory.ts'
import { runWithCacheManager } from '../../../cache/context.ts'
import { RAMFileCacheStore } from '../../../cache/file/ram.ts'
import { runInCommandScope } from '../../../cache/index/scope.ts'
import { CacheManager } from '../../../cache/manager.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { makeFind } from '../../../core/object_store/find.ts'
import { makeStat } from '../../../core/object_store/stat.ts'
import { FakeAccessor, FakeStore, makeDriver, spec } from '../../../core/object_store/fakes.ts'

function makeOps(overrides: Partial<CommandIO> = {}): CommandIO {
  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    readStream: async function* () {},
    readBytes: () => Promise.resolve(new Uint8Array()),
    readdir: () => Promise.resolve([]),
    stat: () =>
      Promise.resolve(new FileStat({ name: 'x', type: FileType.FILE, content: ContentType.TEXT })),
    isMounted: () => true,
    local: true,
    ...overrides,
  }
}

describe('GENERIC_COMMANDS', () => {
  it.each(['find', 'cp'])(
    '%s passes the invocation index through the guarded native find',
    async (name) => {
      const accessor = new FakeAccessor()
      const store = new FakeStore({ 'data/a.txt': 'abc' })
      const driver = makeDriver(store)
      const find = makeFind(driver)
      const stat = makeStat(driver)
      const copied: string[] = []
      const index = new RAMIndexCacheStore()
      const io = makeOps({
        local: false,
        find: (_accessor, path, options, idx) => find(accessor, path, options, idx),
        stat: (_accessor, path, idx) => stat(accessor, path, idx),
        mkdir: () => Promise.resolve(),
        copy: (_accessor, _src, dst) => {
          copied.push(dst.virtual)
          return Promise.resolve()
        },
      })
      const command = generic(name)
      const opts = {
        stdin: null,
        flags: { r: name === 'cp' },
        cwd: '/mnt',
        index,
        io,
      }
      const paths = name === 'cp' ? [spec('/data'), spec('/copy')] : [spec('/data')]
      const cold = await command.fn(accessor, paths, [], opts)
      const coldOut = await materialize(cold?.[0] ?? null)
      expect((await index.get('/mnt/data/a.txt')).entry?.size).toBe(3)
      if (name === 'cp') expect(copied).toEqual(['/mnt/copy/a.txt'])
      else {
        store.connects = 0
        const warm = await command.fn(accessor, paths, [], opts)
        expect(await materialize(warm?.[0] ?? null)).toEqual(coldOut)
        expect(store.connects).toBe(0)
      }
    },
  )

  it('has every builder whatever the backend lacks', () => {
    // A backend without the write-side ops still gets the whole family:
    // `gzip -c`, `tar -t` and `split -n 1/2` only read, and a line that
    // writes is refused at the missing op instead of the command being
    // absent.
    expect(new Set(GENERIC_COMMANDS.map((c) => c.name))).toEqual(
      new Set(BUILDERS.map((b) => b.name)),
    )
    expect(new Set(GENERIC_COMMANDS.map((c) => c.vfs))).toEqual(new Set([null]))
  })

  it('hands back the shared command', () => {
    expect(generic('grep')).toBe(GENERIC_COMMANDS.require('grep'))
  })

  it('registers a copy over a changed table for one backend', () => {
    const ls = generic('ls', { vfs: 'dify', table: walked })
    expect([ls.name, ls.vfs]).toEqual(['ls', 'dify'])
    expect(ls).not.toBe(generic('ls'))
    expect(ls.spec).toEqual(generic('ls').spec)
  })

  it('refuses a name no builder has', () => {
    expect(() => generic('lss')).toThrow(/no generic command named 'lss'/)
    expect(() => generic('lss', { vfs: 'fake', table: walked })).toThrow(
      /no generic command named 'lss'/,
    )
  })

  it('refuses a missing op where it is called, naming the written path', async () => {
    // A builder binds the op up front and a line that never writes never
    // calls it; a copy names its destination.
    const src = PathSpec.fromStrPath('/a.txt')
    const dst = PathSpec.fromStrPath('/b.txt')
    const write = requireOp<NonNullable<CommandIO['write']>>(undefined, 'write')
    await expect(write(new FakeAccessor(), src, new Uint8Array())).rejects.toMatchObject({
      code: 'ENOTSUP',
      virtualPath: '/a.txt',
    })
    const copy = requireOp<NonNullable<CommandIO['copy']>>(undefined, 'copy')
    await expect(copy(new FakeAccessor(), src, dst)).rejects.toMatchObject({
      code: 'ENOTSUP',
      virtualPath: '/b.txt',
    })
  })

  it('registers shuf as a reader', () => {
    // Only `shuf -o` writes, so a backend with no write op still serves it.
    expect(generic('shuf').write).toBe(false)
  })
})

describe('withSlashGuard on the write tier', () => {
  const slashed = new PathSpec({
    virtual: '/mnt/missing',
    directory: '/mnt',
    vfsPath: 'missing',
    rawPath: '/mnt/missing/',
  })

  it('refuses a slashed write before the backend', async () => {
    // open(2) with O_CREAT answers `x/` with EISDIR before looking anything
    // up, so `tee missing/` and `truncate -s0 missing/` must not leave a
    // regular file called `missing` behind; a bare operand passes through.
    const written: string[] = []
    const write = (_accessor: unknown, path: PathSpec): Promise<void> => {
      written.push(path.virtual)
      return Promise.resolve()
    }
    const truncate = (_accessor: unknown, path: PathSpec): Promise<void> => {
      written.push(path.virtual)
      return Promise.resolve()
    }
    const guarded = withSlashGuard(makeOps({ write, append: write, truncate }))
    await expect(
      guarded.write?.(new FakeAccessor(), slashed, new Uint8Array()),
    ).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(
      guarded.append?.(new FakeAccessor(), slashed, new Uint8Array()),
    ).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(guarded.truncate?.(new FakeAccessor(), slashed, 0)).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await guarded.write?.(new FakeAccessor(), spec('/a.txt'), new Uint8Array())
    await guarded.truncate?.(new FakeAccessor(), spec('/a.txt'), 0)
    expect(written).toEqual(['/mnt/a.txt', '/mnt/a.txt'])
  })

  it('leaves write absent when the backend has none', () => {
    const guarded = withSlashGuard(makeOps())
    expect(guarded.write).toBeUndefined()
    expect(guarded.append).toBeUndefined()
  })
})

describe('walked', () => {
  it('sets the native find and du aside', () => {
    const io = makeOps({
      find: () => Promise.resolve([]),
      du: { size: () => Promise.resolve(0), entries: () => Promise.resolve([[], 0]) },
    })
    const rest = walked(io)
    expect(rest.find).toBeUndefined()
    expect(rest.du).toBeUndefined()
    expect(rest.readdir).toBe(io.readdir)
  })
})

describe('scanIo', () => {
  it('guards only a judged mount', () => {
    // A bespoke search scans the raw adapter when nothing on its mount is
    // hidden or refused, and the guarded one when anything is, since the
    // service's own search can answer for more than the operand.
    const io = makeOps()
    const free = { scoped: () => false }
    const judged = { scoped: (virtual: string) => virtual === '/s3' }
    expect(scanIo(io, free, '/s3/')).toEqual([io, false])
    expect(scanIo(io, undefined, '/s3/')).toEqual([io, false])
    const [scan, scoped] = scanIo(io, judged, '/s3/')
    expect(scan).not.toBe(io)
    expect(scoped).toBe(true)
  })
})

describe('a command stat after the freshness probe', () => {
  const path = new PathSpec({ vfsPath: 'a.txt', virtual: '/s3/a.txt', directory: '/s3/' })
  const backend = new FileStat({ name: 'a.txt', size: 7, type: FileType.FILE })
  const probed = new FileStat({ name: 'a.txt', size: 9, type: FileType.FILE })

  function counting(answer: FileStat): { calls: number; ops: CommandIO } {
    const counter = { calls: 0, ops: makeOps() }
    counter.ops = withStatCache(
      withProbeAnswers(
        makeOps({
          local: false,
          stat: () => {
            counter.calls += 1
            return Promise.resolve(answer)
          },
        }),
      ),
    )
    return counter
  }

  // The freshness probe already asked the backend this command; asking again
  // resolves through a listing fresh has not re-checked yet.
  it('serves what the probe saw', async () => {
    const stat = counting(backend)
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
    const served = await runWithCacheManager(manager, () =>
      runInCommandScope(() => {
        manager.noteProbed(path, probed)
        return stat.ops.stat(new FakeAccessor(), path)
      }),
    )
    expect(served).toBe(probed)
    expect(stat.calls).toBe(0)
  })

  it('reaches the backend after a write in the same command', async () => {
    const stat = counting(backend)
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/s3/', true)
    const served = await runWithCacheManager(manager, () =>
      runInCommandScope(async () => {
        manager.noteProbed(path, probed)
        await manager.invalidateAfterWrite(path)
        return stat.ops.stat(new FakeAccessor(), path)
      }),
    )
    expect(served).toBe(backend)
    expect(stat.calls).toBe(1)
  })

  // gdrive-native docs report no size; the rendered length is in the file
  // cache, and serving the probe's answer must not skip that backfill.
  it('still fills the size from the cached render', async () => {
    const stat = counting(backend)
    const cache = new RAMFileCacheStore()
    await cache.set('/s3/a.txt', new TextEncoder().encode('rendered!!'))
    const manager = new CacheManager(cache, null, '/s3/', true)
    const served = await runWithCacheManager(manager, () =>
      runInCommandScope(() => {
        manager.noteProbed(path, new FileStat({ name: 'a.txt', size: null, type: FileType.FILE }))
        return stat.ops.stat(new FakeAccessor(), path)
      }),
    )
    expect([served.size, stat.calls]).toEqual([10, 0])
  })
})

// dify binds `ls` to a cheaper stat than its op table's. The probe's answer is
// the op table's stat, so serving it there would change what a warm `ls -l`
// prints under fresh only.
describe('a command with its own stat', () => {
  it('never serves the probe', async () => {
    const calls = { table: 0, light: 0 }
    const file = (size: number): FileStat =>
      new FileStat({ name: 'a.txt', size, type: FileType.FILE, content: ContentType.TEXT })
    const base = makeOps({
      local: false,
      stat: () => {
        calls.table += 1
        return Promise.resolve(file(7))
      },
    })
    const ls = generic('ls', {
      vfs: 's3',
      table: (io) => ({
        ...io,
        stat: () => {
          calls.light += 1
          return Promise.resolve(file(1))
        },
      }),
    })
    const run = async (name: string): Promise<string> => {
      const command = name === 'ls' ? ls : generic(name)
      const opts = { stdin: null, flags: {}, cwd: '/mnt', io: base }
      const out = await command.fn(new FakeAccessor(), [spec('/a.txt')], [], opts)
      return new TextDecoder().decode(await materialize(out?.[0] ?? null))
    }
    const manager = new CacheManager(new RAMFileCacheStore(), null, '/mnt/', true)
    await runWithCacheManager(manager, () =>
      runInCommandScope(async () => {
        manager.noteProbed(spec('/a.txt'), file(9))
        await run('ls')
        await run('stat')
      }),
    )
    expect(calls).toEqual({ table: 0, light: 1 })
  })
})
