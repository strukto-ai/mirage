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
import { parseSessionProfile } from '../../../policy/profile.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { eacces, efbig, enoent } from '../../../errors/fs.ts'
import { mountedPath } from '../../../utils/key_prefix.ts'
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
  '/d/z.txt': '\0noise\n',
}
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function holds(data: string, text: string, ignoreCase: boolean): boolean {
  return ignoreCase ? data.toLowerCase().includes(text.toLowerCase()) : data.includes(text)
}

interface Mount {
  files?: boolean
  lines?: 'bytes' | 'stream' | 'decline' | null
  upper?: boolean
  resource?: boolean
  refuse?: (message: string) => Error
}

// A RAM mount whose search answers by substring, counting reads. Like a real
// index it never covers a binary-extension file. Mirrors Python's SearchRAM.
class SearchRAM extends RAMVFS {
  reads: string[] = []
  asked: [string, boolean][] = []
  scans: ScanReason[] = []
  pulled: string[] = []
  open = 0
  streams: AsyncIterable<Uint8Array>[] = []

  constructor(readonly mount: Mount = {}) {
    super()
    if (mount.files === false) Object.assign(this, { filesContaining: undefined })
    if (mount.lines === null) Object.assign(this, { linesContaining: undefined })
    if (mount.resource === true) Object.assign(this, { search: () => Promise.resolve(null) })
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
    under: PathSpec[],
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[]> {
    this.asked.push([text, opts.wholeWord])
    const [scope] = under
    if (scope === undefined) return Promise.resolve([])
    const found = [...this.store.files]
      .filter(
        ([key, data]) => holds(DEC.decode(data), text, opts.ignoreCase) && !key.endsWith('.bin'),
      )
      .map(([key]) => mountedPath(scope, this.mount.upper === true ? key.toUpperCase() : key))
    return Promise.resolve(found)
  }

  override linesContaining(
    path: PathSpec,
    text: string,
    opts: { ignoreCase: boolean },
  ): Promise<ByteSource | null> {
    if (this.mount.lines === 'decline') return Promise.resolve(null)
    const data = DEC.decode(this.store.files.get(`/${path.vfsPath}`))
    const kept = data.split(/(?<=\n)/).filter((line) => holds(line, text, opts.ignoreCase))
    if (this.mount.lines !== 'stream') return Promise.resolve(ENC.encode(kept.join('')))
    const pulled = this.pull(kept)
    this.streams.push(pulled)
    return Promise.resolve(pulled)
  }

  private async *pull(kept: string[]): AsyncIterable<Uint8Array> {
    this.open += 1
    try {
      for (const line of kept) {
        this.pulled.push(line)
        yield ENC.encode(line)
        await Promise.resolve()
      }
    } finally {
      this.open -= 1
    }
  }

  override beforeFullScan(_command: string, _under: PathSpec[], reason: ScanReason): Promise<void> {
    this.scans.push(reason)
    const refuse = this.mount.refuse
    return refuse === undefined
      ? Promise.resolve()
      : Promise.reject(refuse(`${reason}; narrow the path`))
  }
}

async function run(vfs: RAMVFS, line: string, hide?: string[]): Promise<[string, string, number]> {
  for (const dir of ['/d', '/d/sub']) vfs.store.dirs.add(dir)
  for (const [key, data] of Object.entries(TREE)) vfs.store.files.set(key, ENC.encode(data))
  const ws = new Workspace({ '/': vfs }, { shellParser: await getTestParser() })
  try {
    if (hide !== undefined) {
      ws.createSession('agent', { profile: parseSessionProfile({ paths: { hide } }) })
    }
    const out = await ws.shell(line, hide === undefined ? {} : { sessionId: 'agent' })
    return [DEC.decode(out.stdout), DEC.decode(out.stderr), out.exitCode]
  } finally {
    await ws.close()
  }
}

const LINES = [
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
  'rg -q --files-without-match ada /d',
  'rg -c --include-zero ada /d',
  "rg -g '*.txt' -i ADA /d",
  'rg -n ada /d',
  'rg -w -e ada -e nothing /d',
  'rg --files /d',
]

const MOUNTS: Record<string, Mount> = {
  files: { lines: null },
  lines: { files: false },
  both: {},
  stream: { files: false, lines: 'stream' },
  decline: { files: false, lines: 'decline' },
  upper: { lines: null, upper: true },
  resource: { lines: null, resource: true },
  'decline-resource': { files: false, lines: 'decline', resource: true },
}

// Twin of test_a_search_never_changes_what_grep_and_rg_print.
it.each(LINES.flatMap((line) => Object.keys(MOUNTS).map((mount) => [line, mount] as const)))(
  'prints what a plain scan prints: %s (%s)',
  async (line, mount) => {
    expect(await run(new SearchRAM(MOUNTS[mount]), line)).toEqual(await run(new RAMVFS(), line))
  },
)

const EVERY = 'a.txt b.txt c.txt sub/d.txt z.txt'

// Twin of test_what_a_search_reads_asks_and_scans.
it.each<[string, string, string | null, string, ScanReason | null]>([
  ['grep -rc ada /d', 'files', 'a.txt sub/d.txt', 'ada', null],
  ['rg -lw ada /d', 'files', 'a.txt sub/d.txt', 'ada -w', null],
  ["grep -rE 'conn.*refused' /d", 'files', 'b.txt', 'refused', null],
  ['grep -ra ada /d', 'files', 'a.txt sub/d.txt w.bin', 'ada', ScanReason.BINARY],
  ['grep -r ada /d /d/c.txt', 'files', 'a.txt c.txt c.txt sub/d.txt', 'ada', null],
  ['grep -r ada /d', 'upper', 'a.txt sub/d.txt', 'ada', null],
  ['grep -r ada /d', 'resource', 'a.txt sub/d.txt', 'ada', null],
  ['grep -r ada /d', 'lines', '', '', null],
  ['grep -rn ada /d', 'lines', 'a.txt sub/d.txt', '', null],
  ['grep -rn ada /d', 'stream', 'a.txt sub/d.txt', '', null],
  ['grep -r ada /d', 'decline', EVERY, '', ScanReason.UNANSWERED],
  ['grep -rn ada /d', 'decline', EVERY, '', ScanReason.UNANSWERED],
  ['grep -rv ada /d', 'both', null, '', ScanReason.EVERY_LINE],
  ['rg --passthru ada /d', 'both', null, '', ScanReason.EVERY_LINE],
  ["grep -r 'a.b' /d", 'both', null, '', ScanReason.NO_TEXT],
  ['rg -L ada /d', 'both', null, '', ScanReason.LINKS],
  ['rg --files-without-match ada /d', 'both', null, '', ScanReason.EVERY_FILE],
  ['rg -c --include-zero ada /d', 'both', null, '', ScanReason.EVERY_FILE],
  ['rg -q --files-without-match ada /d', 'files', null, 'ada', null],
  ['rg --files /d', 'both', '', '', null],
])('%s (%s) reads, asks and scans what it should', async (line, mount, reads, asked, scan) => {
  const vfs = new SearchRAM(MOUNTS[mount])
  expect(await run(vfs, line)).toEqual(await run(new RAMVFS(), line))
  const [text = '', word] = asked.split(' ')
  expect(vfs.asked).toEqual(text === '' ? [] : [[text, word !== undefined]])
  expect(vfs.scans).toEqual(scan === null ? [] : [scan])
  if (reads !== null) {
    const keys = reads === '' ? [] : reads.split(' ')
    expect([...vfs.reads].sort()).toEqual(keys.map((key) => `d/${key}`))
  }
})

// Twin of test_a_file_the_search_does_not_cover_is_always_read: a glob naming
// a directory covers what is below it, and `*` stays within one segment.
it.each([
  [['d/sub'], ['d/a.txt', 'd/b.txt', 'd/c.txt', 'd/sub/d.txt', 'd/z.txt']],
  [['d/*.txt'], ['d/a.txt', 'd/sub/d.txt']],
])('always reads a file outside searchable %j', async (searchable, reads) => {
  const vfs = new SearchRAM({ lines: null })
  Object.assign(vfs, { searchable })
  const line = 'grep -r ada /d'
  expect(await run(vfs, line)).toEqual(await run(new RAMVFS(), line))
  expect([...vfs.reads].sort()).toEqual(reads)
})

// Twin of test_a_hidden_path_is_walked_without_the_search.
it('walks a hidden path without the search', async () => {
  const vfs = new SearchRAM()
  const line = 'grep -r ada /d'
  expect(await run(vfs, line, ['/d/sub'])).toEqual(await run(new RAMVFS(), line, ['/d/sub']))
  expect([vfs.asked, vfs.scans]).toEqual([[], [ScanReason.NO_SEARCH]])
})

// Twin of test_a_streamed_answer_is_pulled_as_far_as_needed.
it.each([
  ['grep -ri ada /d', true],
  ['grep -rin ada /d', false],
  ['grep -ril ada /d', false],
  ['grep -riq ada /d', false],
] as const)('pulls a streamed answer as far as %s needs', async (line, pullsEveryLine) => {
  const vfs = new SearchRAM(MOUNTS.stream)
  await run(vfs, line)
  expect([vfs.pulled.includes('ada lovelace\n'), vfs.open]).toEqual([pullsEveryLine, 0])
})

const refused = (reason: ScanReason): string => `grep: ${reason}; narrow the path\n`
const DENIED = EVERY.split(' ')
  .map((key) => `grep: /d/${key}: Permission denied\n`)
  .join('')
const plainError = (message: string): Error => new Error(message)
const fsError = (message: string): Error => eacces('/d', message)

// Twin of test_a_mount_may_refuse_a_full_scan.
it.each<[string, string, (message: string) => Error, [string, number] | null]>([
  ['grep -rv ada /d', 'both', plainError, [refused(ScanReason.EVERY_LINE), 1]],
  ['grep -r ada /d', 'decline', plainError, [refused(ScanReason.UNANSWERED), 1]],
  ['grep -r ada /d', 'decline', fsError, [DENIED, 2]],
  ['grep -r ada /d', 'decline-resource', fsError, [DENIED, 2]],
  ['grep -r ada /d', 'both', plainError, null],
  ['rg --files /d', 'both', plainError, null],
])('lets a mount refuse %s (%s)', async (line, mount, refuse, out) => {
  const vfs = new SearchRAM({ ...MOUNTS[mount], refuse })
  if (out === null) {
    expect(await run(vfs, line)).toEqual(await run(new RAMVFS(), line))
  } else {
    expect([await run(vfs, line), vfs.reads]).toEqual([['', ...out], []])
  }
})
