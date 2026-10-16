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
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { requireOp } from './adapter.ts'
import type { CommandIO } from '../../config.ts'
import { BUILDERS } from './builders/index.ts'
import { GENERIC_COMMANDS, generic, withSlashGuard, withStatCache } from './factory.ts'
import { FakeAccessor, spec } from '../../../core/object_store/fakes.ts'

function makeOps(overrides: Partial<CommandIO> = {}): CommandIO {
  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    readStream: async function* () {},
    readBytes: () => Promise.resolve(new Uint8Array()),
    readdir: () => Promise.resolve([]),
    stat: () =>
      Promise.resolve(new FileStat({ name: 'x', type: FileType.FILE, content: ContentType.TEXT })),
    isMounted: () => true,
    ...overrides,
  }
}

describe('GENERIC_COMMANDS', () => {
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
    const ls = generic('ls', { vfs: 'dify', table: withStatCache })
    expect([ls.name, ls.vfs]).toEqual(['ls', 'dify'])
    expect(ls).not.toBe(generic('ls'))
    expect(ls.spec).toEqual(generic('ls').spec)
  })

  it('refuses a name no builder has', () => {
    expect(() => generic('lss')).toThrow(/no generic command named 'lss'/)
    expect(() => generic('lss', { vfs: 'fake', table: withStatCache })).toThrow(
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

