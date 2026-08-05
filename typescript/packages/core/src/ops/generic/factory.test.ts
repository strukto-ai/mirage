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

import { describe, expect, it, vi } from 'vitest'

import { Accessor } from '../../accessor/base.ts'
import { PathSpec } from '../../types.ts'
import { makeGenericOps, type OpsTable } from './factory.ts'

const PATH = PathSpec.fromStrPath('/x/a.txt', 'a.txt')
const ACCESSOR = new Accessor()

const makeTable = (extra: Partial<OpsTable> = {}): OpsTable => ({
  readdir: vi.fn(() => Promise.resolve(['/x/a.txt'])),
  readBytes: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3, 4]))),
  stat: vi.fn(() => Promise.resolve(null)),
  ...extra,
})

const rows = (
  ops: ReturnType<typeof makeGenericOps>,
): [string, string | null, string | null, boolean][] =>
  ops
    .map(
      (o) =>
        [o.name, o.resource, o.filetype, o.write] as [
          string,
          string | null,
          string | null,
          boolean,
        ],
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

describe('makeGenericOps', () => {
  it('emits the read-only trio for a bare table', () => {
    expect(rows(makeGenericOps('x', makeTable()))).toEqual([
      ['read', 'x', null, false],
      ['readdir', 'x', null, false],
      ['stat', 'x', null, false],
    ])
  })

  it('emits mutations only for present table fields', () => {
    const ops = makeGenericOps(
      'x',
      makeTable({
        write: vi.fn(),
        mkdir: vi.fn(),
        rename: vi.fn(),
        truncate: vi.fn(),
        append: vi.fn(),
        setAttrs: vi.fn(),
        create: vi.fn(),
        unlink: vi.fn(),
        rmdir: vi.fn(),
      }),
    )
    expect(new Set(ops.map((o) => o.name))).toEqual(
      new Set([
        'read',
        'readdir',
        'stat',
        'write',
        'mkdir',
        'rename',
        'truncate',
        'append',
        'setattr',
        'create',
        'unlink',
        'rmdir',
      ]),
    )
    expect(ops.filter((o) => o.write).every((o) => o.name !== 'read')).toBe(true)
  })

  it('fans out over multiple resources', () => {
    const ops = makeGenericOps(['a', 'b'], makeTable())
    expect(ops).toHaveLength(6)
    expect(new Set(ops.map((o) => o.resource))).toEqual(new Set(['a', 'b']))
  })

  it('skips names in overrides', () => {
    const ops = makeGenericOps('x', makeTable(), {
      overrides: new Set(['readdir']),
    })
    expect(new Set(ops.map((o) => o.name))).toEqual(new Set(['read', 'stat']))
  })

  it('emits no filetype-scoped ops', () => {
    expect(makeGenericOps('x', makeTable()).every((o) => o.filetype === null)).toBe(true)
  })

  it('forwards index into read-like wrappers', async () => {
    const table = makeTable()
    const ops = makeGenericOps('x', table)
    const read = ops.find((o) => o.name === 'read')
    await read?.fn(ACCESSOR, PATH, [], {})
    expect(table.readBytes).toHaveBeenCalledWith(ACCESSOR, PATH, undefined)
  })

  it('decodes write data from args', async () => {
    const write = vi.fn()
    const ops = makeGenericOps('x', makeTable({ write }))
    const op = ops.find((o) => o.name === 'write')
    const data = new Uint8Array([9])
    await op?.fn(ACCESSOR, PATH, [data], {})
    expect(write).toHaveBeenCalledWith(ACCESSOR, PATH, data)
  })

  it('validates rename dst and truncate length', () => {
    const ops = makeGenericOps(
      'x',
      makeTable({
        rename: vi.fn(),
        truncate: vi.fn(),
      }),
    )
    const rename = ops.find((o) => o.name === 'rename')
    const truncate = ops.find((o) => o.name === 'truncate')
    expect(() => rename?.fn(ACCESSOR, PATH, ['not-a-spec'], {})).toThrow(TypeError)
    expect(() => truncate?.fn(ACCESSOR, PATH, ['nope'], {})).toThrow(TypeError)
  })

  it('mkdirParents forwards the parents flag', async () => {
    const mkdir = vi.fn()
    const ops = makeGenericOps('x', makeTable({ mkdir }), {
      mkdirParents: true,
    })
    await ops.find((o) => o.name === 'mkdir')?.fn(ACCESSOR, PATH, [], {})
    expect(mkdir).toHaveBeenCalledWith(ACCESSOR, PATH, true)
  })

  it('emulated truncate pads and cuts through readBytes + write', async () => {
    const write = vi.fn()
    const ops = makeGenericOps('x', makeTable({ write }), {
      emulateTruncate: true,
    })
    const truncate = ops.find((o) => o.name === 'truncate')
    await truncate?.fn(ACCESSOR, PATH, [6], {})
    expect(write).toHaveBeenCalledWith(ACCESSOR, PATH, new Uint8Array([1, 2, 3, 4, 0, 0]))
    await truncate?.fn(ACCESSOR, PATH, [2], {})
    expect(write).toHaveBeenLastCalledWith(ACCESSOR, PATH, new Uint8Array([1, 2]))
  })

  it('native truncate wins over emulation', () => {
    const ops = makeGenericOps(
      'x',
      makeTable({
        write: vi.fn(),
        truncate: vi.fn(),
      }),
      { emulateTruncate: true },
    )
    expect(ops.filter((o) => o.name === 'truncate')).toHaveLength(1)
  })

  it('forwards the index into reads by default', async () => {
    const table = makeTable()
    const ops = makeGenericOps('x', table)
    const index = {} as never
    const readdir = ops.find((o) => o.name === 'readdir')
    await readdir?.fn(ACCESSOR, PATH, [], { index })
    expect(table.readdir).toHaveBeenCalledWith(ACCESSOR, PATH, index)
  })

  it('forwardIndex false keeps reads index-less', async () => {
    const table = makeTable()
    const ops = makeGenericOps('x', table, { forwardIndex: false })
    const readdir = ops.find((o) => o.name === 'readdir')
    await readdir?.fn(ACCESSOR, PATH, [], { index: {} as never })
    expect(table.readdir).toHaveBeenCalledWith(ACCESSOR, PATH, undefined)
  })

  it('emulateTruncate without write throws', () => {
    expect(() => makeGenericOps('x', makeTable(), { emulateTruncate: true })).toThrow(
      'emulateTruncate requires a write op',
    )
  })
})

const readOp = (table: OpsTable): ReturnType<typeof makeGenericOps>[number] => {
  const op = makeGenericOps('x', table).find((o) => o.name === 'read')
  if (op === undefined) throw new Error('no read op emitted')
  return op
}

const DATA = new TextEncoder().encode('data')
const bytes = (table: OpsTable): OpsTable =>
  Object.assign(table, { readBytes: vi.fn(() => Promise.resolve(DATA)) })

describe('the read op and byte ranges', () => {
  it('never asks for a range on a whole-file read', async () => {
    const table = bytes(makeTable())
    expect(await readOp(table).fn(ACCESSOR, PATH, [], {})).toEqual(DATA)
    expect(table.readBytes).toHaveBeenCalledOnce()
  })

  it('reads and slices for a backend without ranges', async () => {
    // Correct everywhere, and the only meaningful answer for a backend that
    // renders its bytes rather than storing them.
    const table = bytes(makeTable())
    const got = await readOp(table).fn(ACCESSOR, PATH, [], { offset: 1, size: 2 })
    expect(got).toEqual(new TextEncoder().encode('at'))
  })

  it('runs to the end when slicing without a size', async () => {
    const table = bytes(makeTable())
    const got = await readOp(table).fn(ACCESSOR, PATH, [], { offset: 2 })
    expect(got).toEqual(new TextEncoder().encode('ta'))
  })

  it('prefers a native range and skips the whole read', async () => {
    // The point of the whole change: on an object store this is one ranged GET
    // rather than fetching the object and throwing most away.
    const native = vi.fn(() => Promise.resolve(new TextEncoder().encode('ng')))
    const table = bytes(makeTable({ readRange: native }))
    const got = await readOp(table).fn(ACCESSOR, PATH, [], { offset: 1, size: 2 })
    expect(got).toEqual(new TextEncoder().encode('ng'))
    expect(native).toHaveBeenCalledOnce()
    expect(table.readBytes).not.toHaveBeenCalled()
  })

  it('bypasses a native range for a whole-file read', async () => {
    const native = vi.fn(() => Promise.resolve(new TextEncoder().encode('ng')))
    const table = bytes(makeTable({ readRange: native }))
    expect(await readOp(table).fn(ACCESSOR, PATH, [], {})).toEqual(DATA)
    expect(native).not.toHaveBeenCalled()
  })

  it('asks the backend nothing for a zero-length read', async () => {
    // No store can express an empty range, and the answer is known, so it is
    // served here rather than turned into a request that would either fetch the
    // whole object or be refused.
    const native = vi.fn(() => Promise.resolve(new TextEncoder().encode('ng')))
    const table = bytes(makeTable({ readRange: native }))
    expect(await readOp(table).fn(ACCESSOR, PATH, [], { offset: 1, size: 0 })).toEqual(
      new Uint8Array(0),
    )
    expect(native).not.toHaveBeenCalled()
    expect(table.readBytes).not.toHaveBeenCalled()
  })
})
