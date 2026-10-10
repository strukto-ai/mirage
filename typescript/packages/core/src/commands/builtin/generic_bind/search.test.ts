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
import { ScanReason, type SearchQuery } from '../../../vfs/types.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { efbig, enoent } from '../../../errors/fs.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, CommandOpts, CommandIO } from '../../config.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'

import { runSearch } from './search.ts'
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
    expect(await drain(out)).toContain('x ada')
    expect(result.exitCode).toBe(0)
  })

  it.each([
    [{ v: true }, 'ada', 'y\n', 0],
    [{ line_regexp: true }, 'ada', '', 1],
    [{ line_regexp: true }, 'y', 'y\n', 0],
  ] as const)(
    'defers a shaping flag to the generic scan: %o %s',
    async (flags, pattern, expected, code) => {
      const provider = vi.fn(() => Promise.resolve(['provider substring hit']))
      const search = searchCommand({ note: provider }, makeIO(), {})
      const [out, result] = unwrap(
        await search(new FakeAccessor(), [spec('/rooms/red/a.json')], [pattern], opts(flags)),
      )
      expect([await drain(out), result.exitCode]).toEqual([expected, code])
      expect(provider).not.toHaveBeenCalled()
    },
  )

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
    expect(await drain(out)).toContain('x ada')
    expect(result.exitCode).toBe(0)
  })

  it('reports a stream failure after data has flowed', async () => {
    const io = makeIO({
      // eslint-disable-next-line @typescript-eslint/require-await
      readStream: async function* (_accessor, p) {
        yield CONTENT
        throw enoent(p)
      },
    })
    const search = searchCommand({ room: roomSearcher }, io, { stream: true })
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
    )
    await drain(out)
    expect(result.exitCode).toBe(2)
    expect(await result.stderrStr()).toBe('grep: /h/rooms/red/a.json: No such file or directory\n')
  })

  it('falls back to the scan when the push-down is past the read cap', async () => {
    // A push-down past the mount's read cap cannot print its answer; the scan
    // reads the operand, which refuses the same way against the operand, and
    // the generic reports it as typed (`grep: <path>: File too large`).
    const refusing: Searcher<FakeAccessor> = (_accessor, match) =>
      Promise.reject(efbig(`rooms/${match.slots.room ?? ''}/${match.slots.note ?? ''}`))
    const io = makeIO({ readBytes: (_accessor, p) => Promise.reject(efbig(p)) })
    const search = searchCommand({ note: refusing }, io, {})
    const [out, result] = unwrap(
      await search(new FakeAccessor(), [spec('/rooms/red/a.json')], ['ada'], opts()),
    )
    expect(await drain(out)).toBe('')
    expect(result.exitCode).toBe(2)
    expect(await result.stderrStr()).toBe('grep: /h/rooms/red/a.json: File too large\n')
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

const TREE: Record<string, string> = {
  '/d/a.txt': 'ada here\nnothing\n',
  '/d/b.txt': 'conn was refused\nbob\n',
  '/d/c.txt': 'nothing\n',
  '/d/sub/d.txt': 'ADA upper\nada lovelace\n',
  '/d/w.bin': 'ada in a blob\n',
}
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function holds(data: string, text: string, ignoreCase: boolean): boolean {
  return ignoreCase ? data.toLowerCase().includes(text.toLowerCase()) : data.includes(text)
}

// A RAM mount whose search answers by substring, counting reads. Like a real
// index it never covers a binary-extension file. Mirrors Python's SearchRAM.
class SearchRAM extends RAMVFS {
  reads: string[] = []
  asked: [string, boolean][] = []
  scans: ScanReason[] = []

  constructor(files = true, lines = true) {
    super()
    if (!files) Object.assign(this, { filesContaining: undefined })
    if (!lines) Object.assign(this, { linesContaining: undefined })
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset?: number,
    size?: number | null,
  ): Promise<Uint8Array> {
    this.reads.push(path.vfsPath)
    return super.read(path, index, offset, size)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    this.reads.push(path.vfsPath)
    return super.readStream(path, index)
  }

  override filesContaining(
    text: string,
    _under: PathSpec[],
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<Set<string>> {
    this.asked.push([text, opts.wholeWord])
    const keys = [...this.store.files]
      .filter(
        ([key, data]) => holds(DEC.decode(data), text, opts.ignoreCase) && !key.endsWith('.bin'),
      )
      .map(([key]) => stripSlash(key))
    return Promise.resolve(new Set(keys))
  }

  override linesContaining(
    path: PathSpec,
    text: string,
    opts: { ignoreCase: boolean },
  ): Promise<Uint8Array> {
    const data = DEC.decode(this.store.files.get(`/${path.vfsPath}`))
    const kept = data.split(/(?<=\n)/).filter((line) => holds(line, text, opts.ignoreCase))
    return Promise.resolve(ENC.encode(kept.join('')))
  }

  override beforeFullScan(_command: string, _under: PathSpec[], reason: ScanReason): Promise<void> {
    this.scans.push(reason)
    return Promise.resolve()
  }
}

async function run(vfs: RAMVFS, line: string): Promise<[string, string, number]> {
  for (const dir of ['/d', '/d/sub']) vfs.store.dirs.add(dir)
  for (const [key, data] of Object.entries(TREE)) vfs.store.files.set(key, ENC.encode(data))
  const ws = new Workspace({ '/': vfs }, { shellParser: await getTestParser() })
  try {
    const out = await ws.shell(line)
    return [DEC.decode(out.stdout), DEC.decode(out.stderr), out.exitCode]
  } finally {
    await ws.close()
  }
}

// Twin of test_a_search_never_changes_what_grep_and_rg_print.
describe('a search never changes what grep and rg print', () => {
  const lines = [
    'grep -r ada /d',
    'grep -rc ada /d',
    'grep -rL ada /d',
    'grep -rlw ada /d',
    'grep -rn ada /d',
    'grep -ri ADA /d',
    "grep -rx 'ada lovelace' /d",
    'grep -r -e ada -e bob /d',
    "grep -rE 'conn.*refused' /d",
    'grep -r --exclude-dir=sub ada /d',
    'grep -r -C1 ada /d',
    'grep -rv ada /d',
    'grep -ra ada /d',
    'grep -rh ada /d /d/w.bin',
    'grep -rq ada /d',
    'rg ada /d',
    'rg -c ada /d',
    'rg --files-without-match ada /d',
    "rg -g '*.txt' -i ADA /d",
    'rg -n ada /d',
    'rg -w -e ada -e nothing /d',
  ]
  const flavors: [boolean, boolean][] = [
    [true, false],
    [false, true],
    [true, true],
  ]
  it.each(lines.flatMap((line) => flavors.map(([files, ls]) => [line, files, ls] as const)))(
    '%s (files=%s, lines=%s)',
    async (line, files, ls) => {
      expect(await run(new SearchRAM(files, ls), line)).toEqual(await run(new RAMVFS(), line))
    },
  )
})

// Twin of test_only_the_files_a_search_returns_are_read.
describe('only the files a search returns are read', () => {
  it.each<[string, string[], [string, boolean][]]>([
    ['grep -rc ada /d', ['a.txt', 'sub/d.txt'], [['ada', false]]],
    ['rg -lw ada /d', ['a.txt', 'sub/d.txt'], [['ada', true]]],
    ["grep -rE 'conn.*refused' /d", ['b.txt'], [['refused', false]]],
    ['grep -ra ada /d', ['a.txt', 'sub/d.txt', 'w.bin'], [['ada', false]]],
    ['grep -r ada /d /d/c.txt', ['a.txt', 'c.txt', 'c.txt', 'sub/d.txt'], [['ada', false]]],
  ])('%s', async (line, reads, asked) => {
    const vfs = new SearchRAM(true, false)
    await run(vfs, line)
    expect([[...vfs.reads].sort(), vfs.asked]).toEqual([reads.map((key) => `d/${key}`), asked])
  })
})

describe('matching lines', () => {
  it('stand in for a file when nothing else prints', async () => {
    const lines = new SearchRAM(false, true)
    expect((await run(lines, 'grep -r ada /d'))[2]).toBe(0)
    expect(lines.reads).toEqual([])
    const numbered = new SearchRAM(false, true)
    await run(numbered, 'grep -rn ada /d')
    expect([...numbered.reads].sort()).toEqual(['d/a.txt', 'd/sub/d.txt'])
  })
})

describe('a walk that reads every file', () => {
  it.each<[string, ScanReason]>([
    ['grep -rv ada /d', ScanReason.EVERY_LINE],
    ['rg --passthru ada /d', ScanReason.EVERY_LINE],
    ["grep -r 'a.b' /d", ScanReason.NO_TEXT],
    ['rg -L ada /d', ScanReason.LINKS],
  ])('%s says why', async (line, reason) => {
    const vfs = new SearchRAM()
    await run(vfs, line)
    expect([vfs.scans, vfs.asked]).toEqual([[reason], []])
  })

  it('may be refused by the mount', async () => {
    class Refusing extends SearchRAM {
      override beforeFullScan(_c: string, _u: PathSpec[], reason: ScanReason): Promise<void> {
        return Promise.reject(new Error(`${reason}; narrow the path`))
      }
    }
    expect(await run(new Refusing(), 'grep -rv ada /d')).toEqual([
      '',
      'grep: the output needs lines that do not match; narrow the path\n',
      1,
    ])
    expect((await run(new Refusing(), 'grep -r ada /d'))[2]).toBe(0)
  })
})
