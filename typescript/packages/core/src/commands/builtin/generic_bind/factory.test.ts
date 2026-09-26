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
import { type CommandIO, requireOp } from './adapter.ts'
import { BUILDERS } from './builders/index.ts'
import { makeGenericCommands, withSlashGuard } from './factory.ts'
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

describe('makeGenericCommands', () => {
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
      const commands = makeGenericCommands(
        's3',
        makeOps({
          local: false,
          find: (_accessor, path, options, idx) => find(accessor, path, options, idx),
          stat: (_accessor, path, idx) => stat(accessor, path, idx),
          mkdir: () => Promise.resolve(),
          copy: (_accessor, _src, dst) => {
            copied.push(dst.virtual)
            return Promise.resolve()
          },
        }),
      )
      const command = commands.find((c) => c.name === name)
      if (command === undefined) throw new Error('command missing')
      const opts = {
        stdin: null,
        flags: { r: name === 'cp' },
        filetypeFns: null,
        cwd: '/mnt',
        index,
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

  it('emits read/metadata commands from the catalog', () => {
    const names = new Set(makeGenericCommands('ram', makeOps()).map((c) => c.name))
    expect(names.has('cat')).toBe(true)
    expect(names.has('ls')).toBe(true)
    expect(names.has('stat')).toBe(true)
  })

  it('skips overridden commands', () => {
    const names = makeGenericCommands('ram', makeOps(), {
      overrides: new Set(['stat', 'du']),
    }).map((c) => c.name)
    expect(names).not.toContain('stat')
    expect(names).not.toContain('du')
    expect(names).toContain('cat')
  })

  // A name no builder has did nothing, so a typo left the generic registered
  // beside the bespoke command, and mem0's `search` read as if it displaced
  // something.
  it('refuses a name no builder has', () => {
    expect(() =>
      makeGenericCommands('fake', makeOps(), { overrides: new Set(['cat', 'search']) }),
    ).toThrow(/no generic builder named search/)
    expect(() =>
      makeGenericCommands('fake', makeOps(), { provisionOverrides: { gerp: () => null } }),
    ).toThrow(/no generic builder named gerp/)
    expect(() =>
      makeGenericCommands('fake', makeOps(), { opsOverrides: { lss: makeOps() } }),
    ).toThrow(/no generic builder named lss/)
  })

  it('attaches aggregate only for local backends', () => {
    const local = makeGenericCommands('ram', makeOps({ local: true })).find((c) => c.name === 'cat')
    const remote = makeGenericCommands('s3', makeOps({ local: false })).find(
      (c) => c.name === 'cat',
    )
    expect(local?.aggregate).not.toBeNull()
    expect(remote?.aggregate).toBeNull()
  })

  it('registers every command whatever the backend lacks', () => {
    // A backend without the write-side ops still gets the whole family:
    // `gzip -c`, `tar -t` and `split -n 1/2` only read, and a line that
    // writes is refused at the missing op instead of the command being
    // absent.
    const names = new Set(makeGenericCommands('hf_buckets', makeOps()).map((c) => c.name))
    expect(names).toEqual(new Set(BUILDERS.map((b) => b.name)))
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

  it('registers ops-gated commands once the backend supplies them', () => {
    const names = new Set(
      makeGenericCommands(
        'disk',
        makeOps({
          write: () => Promise.resolve(),
          rmdir: () => Promise.resolve(),
          truncate: () => Promise.resolve(),
        }),
      ).map((c) => c.name),
    )
    expect(names.has('rmdir')).toBe(true)
    expect(names.has('truncate')).toBe(true)
  })

  it('registers shuf on a read-only backend', () => {
    // Only `shuf -o` writes, so a backend with no write op still serves it.
    const shuf = makeGenericCommands('chroma', makeOps()).find((c) => c.name === 'shuf')
    expect(shuf).toBeDefined()
    expect(shuf?.write).toBe(false)
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
