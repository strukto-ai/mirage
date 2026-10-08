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
import { Accessor } from '../../../accessor/base.ts'
import { JSON_NAME } from '../../../core/hierarchy/codec.ts'
import { Slot, Scope, makeDetectScope } from '../../../core/hierarchy/scope.ts'
import type { Searcher } from '../../../core/hierarchy/search.ts'
import type { SearchQuery } from '../../../vfs/types.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { efbig, enoent } from '../../../errors/fs.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, CommandOpts, CommandIO } from '../../config.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'

import { narrowScope, runSearch } from './search.ts'
import { makeSearchOp } from '../../../core/hierarchy/search.ts'

const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'rooms', segments: ['rooms'], probed: false }),
  new Scope({ kind: 'room', segments: ['rooms', new Slot('room')] }),
  new Scope({
    kind: 'note',
    segments: ['rooms', new Slot('room'), new Slot('note', JSON_NAME)],
    leaf: true,
    filetype: ContentType.JSON,
  }),
]

const detectScope = makeDetectScope(SCOPES)

class FakeAccessor extends Accessor {}

const CONTENT = new TextEncoder().encode('x ada\ny\n')

function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/h${mountPath}` : '/h',
    directory: '/h/',
    vfsPath: key,
  })
}

function makeIO(overrides: Partial<CommandIO<FakeAccessor>> = {}): CommandIO<FakeAccessor> {
  return {
    readdir: () => Promise.resolve([]),
    readBytes: () => Promise.resolve(CONTENT),
    // eslint-disable-next-line @typescript-eslint/require-await
    readStream: async function* () {
      yield CONTENT
    },
    stat: () =>
      Promise.resolve(
        new FileStat({
          name: 'a.json',
          type: FileType.FILE,
          content: ContentType.JSON,
          size: CONTENT.length,
        }),
      ),
    isMounted: () => true,
    local: false,
    ...overrides,
  }
}

const roomSearcher: Searcher<FakeAccessor> = (_accessor, match, query) =>
  Promise.resolve([`rooms/${match.slots.room ?? ''}:${query.query}`])

const emptySearcher: Searcher<FakeAccessor> = () => Promise.resolve([])

function opts(flags: CommandOpts['flags'] = {}): CommandOpts {
  return { stdin: null, flags, cwd: '/' }
}

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('command returned null')
  return result
}

async function drain(source: ByteSource | null): Promise<string> {
  if (source === null) return ''
  if (source instanceof Uint8Array) return new TextDecoder().decode(source)
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks.map((c) => new TextDecoder().decode(c)).join('')
}

function searchCommand(
  searchers: Readonly<Record<string, Searcher<FakeAccessor>>>,
  io: CommandIO<FakeAccessor>,
  options: { guard?: boolean; stream?: boolean },
) {
  const search = makeSearchOp(detectScope, searchers, options.guard === true ? io.stat : undefined)
  return (accessor: FakeAccessor, paths: PathSpec[], texts: string[], opts: CommandOpts) =>
    runSearch(
      {
        ...io,
        search: { search, meta: { grep: { mode: 'literal', stream: options.stream ?? false } } },
      },
      'grep',
      accessor,
      paths,
      texts,
      opts,
    )
}

describe('adapter search on a - operand', () => {
  it('reads the pipe, not the backend', async () => {
    // A `-` operand is the line's stdin, which no backend holds. Asked about
    // it, a search that answers any operand said "no match" and the pipe was
    // never read.
    const asked: string[] = []
    const answerEverything = (_accessor: FakeAccessor, operand: PathSpec): Promise<string[]> => {
      asked.push(operand.rawPath)
      return Promise.resolve([])
    }
    const dash = new PathSpec({
      virtual: '/h/-',
      directory: '/h/',
      vfsPath: '-',
      resolved: true,
      rawPath: '-',
    })
    for (const name of ['grep', 'rg'] as const) {
      const io: CommandIO<FakeAccessor> = {
        ...makeIO(),
        search: { search: answerEverything, meta: { grep: { mode: 'literal', stream: false } } },
      }
      const stdin = new TextEncoder().encode('x ada\n')
      const [out, result] = unwrap(
        await runSearch(io, name, new FakeAccessor(), [dash], ['ada'], { ...opts(), stdin }),
      )
      expect([await drain(out), result.exitCode]).toEqual(['x ada\n', 0])
    }
    expect(asked).toEqual([])
  })
})

describe('adapter search', () => {
  it('answers a matched kind from its searcher', async () => {
    const search = searchCommand({ room: roomSearcher }, makeIO(), {})
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(0)
    expect(await drain(out)).toBe('rooms/red:ada\n')
  })

  it('answers an empty search with exit 1', async () => {
    const search = searchCommand({ room: emptySearcher }, makeIO(), {})
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(1)
    expect(await drain(out)).toBe('')
  })

  it('sends an unmatched kind to the generic scan', async () => {
    const search = searchCommand({ room: roomSearcher }, makeIO(), {})
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(0)
    expect(await drain(out)).toContain('x ada')
  })

  it('defers a shaping flag to the generic scan', async () => {
    const search = searchCommand({ room: roomSearcher }, makeIO(), {})
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts({ v: true })),
    )
    expect(result.exitCode).toBe(0)
    const drained = await drain(out)
    expect(drained).toContain('y')
    expect(drained).not.toContain('x ada')
  })

  it('falls back to the whole read when the stream refuses before yielding', async () => {
    // A native stream that refuses a kind before yielding (mongodb's
    // documents-only stream on schema.json) must not fail the scan.
    const io = makeIO({
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      readStream: async function* (_accessor, p) {
        throw enoent(p)
      },
    })
    const search = searchCommand({ room: roomSearcher }, io, { stream: true })
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
    )
    expect(result.exitCode).toBe(0)
    expect(await drain(out)).toContain('x ada')
  })

  it('propagates a stream failure after data has flowed', async () => {
    const io = makeIO({
      // eslint-disable-next-line @typescript-eslint/require-await
      readStream: async function* (_accessor, p) {
        yield CONTENT
        throw enoent(p)
      },
    })
    const search = searchCommand({ room: roomSearcher }, io, { stream: true })
    await expect(
      (async () => {
        const [out] = unwrap(
          await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
        )
        await drain(out)
      })(),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to the scan when the push-down is past the read cap', async () => {
    // A push-down past the mount's read cap cannot print its answer; the scan
    // reads the operand, which refuses the same way against the operand, and
    // the executor reports it as typed (`grep: <path>: File too large`).
    const refusing: Searcher<FakeAccessor> = (_accessor, match) =>
      Promise.reject(efbig(`rooms/${match.slots.room ?? ''}/${match.slots.note ?? ''}`))
    const io = makeIO({ readBytes: (_accessor, p) => Promise.reject(efbig(p)) })
    const search = searchCommand({ note: refusing }, io, {})
    const [out] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
    )
    await expect(drain(out)).rejects.toMatchObject({
      code: 'EFBIG',
      virtualPath: '/h/rooms/red/a.json',
    })
  })

  it('probes existence before searching when guarded', async () => {
    const io = makeIO({ stat: (_accessor, p) => Promise.reject(enoent(p)) })
    const search = searchCommand({ room: roomSearcher }, io, { guard: true })
    await expect(
      search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts()),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('carries the honored flags on the query', async () => {
    const seen: SearchQuery[] = []
    const recorder: Searcher<FakeAccessor> = (_accessor, _match, query) => {
      seen.push(query)
      return Promise.resolve(['line'])
    }
    const search = searchCommand({ room: recorder }, makeIO(), {})
    await search(new FakeAccessor(), [spec('/rooms/red')], ['ada'], opts({ i: true }))
    expect(seen[0]?.options?.grep).toMatchObject({ ignore_case: true, fixed_string: false })
  })
})

describe('narrowScope', () => {
  const scope = new PathSpec({ virtual: '/data', directory: '/data', vfsPath: '' })
  const hit = (virtual: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: '',
      vfsPath: virtual.replace(/^\/data\//, ''),
      resolved: true,
    })
  const directory = new FileStat({ name: 'data', type: FileType.DIRECTORY })

  function narrowing(
    answer: PathSpec[] | null = [hit('/data/a.txt')],
    stat: CommandIO<FakeAccessor>['stat'] = () => Promise.resolve(directory),
    enabled = true,
  ) {
    const narrowPaths = vi.fn(() => Promise.resolve(answer))
    const io = makeIO({ stat, contentSearch: { narrowPaths, enabled: () => enabled } })
    return { io, narrowPaths }
  }

  async function run(
    io: CommandIO<FakeAccessor>,
    gates: Partial<{ recursive: boolean; exactFileSet: boolean; wholeWord: boolean }> = {},
  ) {
    return narrowScope(io, new FakeAccessor(), [scope], 'needle', {
      fixedString: false,
      recursive: true,
      wholeWord: true,
      exactFileSet: false,
      index: undefined,
      ...gates,
    })
  }

  it('narrows a recursive whole-word literal to its candidates', async () => {
    const { io, narrowPaths } = narrowing()
    const r = await run(io)
    expect(r.usedSearch).toBe(true)
    expect(r.resolved.map((p) => p.virtual)).toEqual(['/data/a.txt'])
    expect(narrowPaths).toHaveBeenCalledOnce()
  })

  it.each([{ recursive: false }, { exactFileSet: true }, { wholeWord: false }])(
    'scans every file when a gate fails: %o',
    async (gates) => {
      const { io, narrowPaths } = narrowing()
      const r = await run(io, gates)
      expect([r.resolved.map((p) => p.virtual), r.usedSearch]).toEqual([['/data'], false])
      expect(narrowPaths).not.toHaveBeenCalled()
    },
  )

  it('scans every file on a mount that did not opt in', async () => {
    const { io, narrowPaths } = narrowing(undefined, undefined, false)
    expect((await run(io)).usedSearch).toBe(false)
    expect(narrowPaths).not.toHaveBeenCalled()
  })

  it('scans every file for a file or missing operand', async () => {
    for (const stat of [
      () => Promise.resolve(new FileStat({ name: 'x.txt', type: FileType.FILE })),
      () => Promise.reject(enoent('/data')),
    ]) {
      const { io, narrowPaths } = narrowing(undefined, stat)
      expect((await run(io)).usedSearch).toBe(false)
      expect(narrowPaths).not.toHaveBeenCalled()
    }
  })

  it('scans every file when the index cannot answer or answers nothing', async () => {
    for (const answer of [null, []]) {
      expect((await run(narrowing(answer).io)).usedSearch).toBe(false)
    }
  })

  it('drops binary candidates, possibly to none', async () => {
    const some = await run(narrowing([hit('/data/a.parquet'), hit('/data/a.txt')]).io)
    expect([some.usedSearch, some.resolved.map((p) => p.virtual)]).toEqual([true, ['/data/a.txt']])
    expect(await run(narrowing([hit('/data/a.parquet')]).io)).toEqual({
      resolved: [],
      usedSearch: true,
    })
  })
})
