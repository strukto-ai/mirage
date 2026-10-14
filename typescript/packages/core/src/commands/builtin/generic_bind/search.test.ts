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

import { expect, it } from 'vitest'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { parseSessionProfile } from '../../../policy/profile.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { MountMode, type PathSpec } from '../../../types.ts'
import { eacces } from '../../../errors/fs.ts'
import { mountedPath } from '../../../utils/key_prefix.ts'
import type { ByteSource } from '../../../io/types.ts'

const TREE: Record<string, string> = {
  '/d/a.txt': 'ada here\nnothing\n',
  '/d/b.txt': 'conn was refused\nbob\n',
  '/d/c.txt': 'nothing\n',
  '/d/sub/d.txt': 'ADA upper\nada lovelace\n',
  '/d/w.bin': 'ada in a blob\n',
  '/d/z.txt': '\0noise\n',
}
const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })

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
  scans: string[] = []
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
    scope: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[]> {
    this.asked.push([text, opts.wholeWord])
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

  override beforeFullScan(path: PathSpec, files: number | null): Promise<void> {
    this.scans.push(path.virtual)
    const refuse = this.mount.refuse
    return refuse === undefined
      ? Promise.resolve()
      : Promise.reject(refuse(`${String(files)} files in scope, narrow the path`))
  }
}

async function run(
  vfs: RAMVFS,
  line: string,
  hide?: string[],
  pins: Record<string, string> = {},
  deny?: string[],
): Promise<[string, string, number]> {
  for (const dir of ['/d', '/d/sub']) vfs.store.dirs.add(dir)
  for (const [key, data] of Object.entries(TREE)) vfs.store.files.set(key, ENC.encode(data))
  const ws = new Workspace(
    { '/': vfs },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  for (const [path, rev] of Object.entries(pins)) ws.mount('/').revisions.set(path, rev)
  const scoped = hide !== undefined || deny !== undefined
  try {
    if (scoped) {
      const rules = deny === undefined ? [] : [{ reason: 'sealed', paths: deny }]
      ws.createSession('agent', {
        profile: parseSessionProfile({ paths: { hide: hide ?? [] }, commands: { deny: rules } }),
      })
    }
    const out = await ws.shell(line, scoped ? { sessionId: 'agent' } : {})
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
  "echo 'x ada' | grep ada - /d/c.txt",
  "echo 'x ada' | rg ada - /d",
  'ln -s a.txt /d/la.txt && ln -s sub /d/ls && grep -R ada /d',
  'ln -s a.txt /d/la.txt && ln -s sub /d/ls && rg -L ada /d',
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

// rg drops a byte-order mark only where a file starts, which a line answer
// cannot say it does, so an answer that starts with one is not used, and the
// file is read as one no search answered. Twin of
// test_rg_reads_a_file_whose_line_answer_starts_with_a_mark.
const MARKED: Record<string, number[]> = {
  '/m/mid.txt': [...ENC.encode('skip\n'), 0xef, 0xbb, 0xbf, ...ENC.encode('ada\n')],
  '/m/top.txt': [0xef, 0xbb, 0xbf, ...ENC.encode('ada\n')],
}

function marked(vfs: RAMVFS): RAMVFS {
  vfs.store.dirs.add('/m')
  for (const [key, data] of Object.entries(MARKED)) vfs.store.files.set(key, new Uint8Array(data))
  return vfs
}

it.each(['bytes', 'stream'] as const)(
  'reads a file whose rg line answer starts with a mark (%s)',
  async (lines) => {
    const vfs = new SearchRAM({ files: false, lines })
    const searched = await run(marked(vfs), 'rg -x ada /m')
    expect(searched).toEqual(await run(marked(new RAMVFS()), 'rg -x ada /m'))
    expect(searched[0]).toBe('/m/top.txt:ada\n')
    expect(vfs.scans).toEqual(['/m'])
  },
)

// Under -E none rg keeps the mark, so the answer stands and nothing is read.
// Twin of test_rg_keeps_a_marked_line_answer_under_no_encoding.
it.each(['bytes', 'stream'] as const)(
  'keeps a marked rg line answer under -E none (%s)',
  async (lines) => {
    const vfs = new SearchRAM({ files: false, lines })
    const searched = await run(marked(vfs), 'rg -E none ada /m')
    expect(searched).toEqual(await run(marked(new RAMVFS()), 'rg -E none ada /m'))
    expect([vfs.reads, vfs.scans]).toEqual([[], []])
  },
)

const EVERY = 'a.txt b.txt c.txt sub/d.txt z.txt'

// Twin of test_what_a_search_reads_asks_and_scans.
it.each<[string, string, string | null, string, boolean]>([
  ['grep -rc ada /d', 'files', 'a.txt sub/d.txt', 'ada', false],
  ['rg -lw ada /d', 'files', 'a.txt sub/d.txt', 'ada -w', false],
  ["grep -rE 'conn.*refused' /d", 'files', 'b.txt', 'refused', false],
  ['grep -ra ada /d', 'files', 'a.txt sub/d.txt w.bin', 'ada', true],
  ['grep -r ada /d /d/c.txt', 'files', 'a.txt c.txt c.txt sub/d.txt', 'ada', false],
  ['grep -r ada /d', 'upper', 'a.txt sub/d.txt', 'ada', false],
  ['grep -r ada /d', 'resource', 'a.txt sub/d.txt', 'ada', false],
  ['grep -r ada /d', 'lines', '', '', false],
  ['grep -rn ada /d', 'lines', 'a.txt sub/d.txt', '', false],
  ['grep -rn ada /d', 'stream', 'a.txt sub/d.txt', '', false],
  ['grep -r ada /d', 'decline', EVERY, '', true],
  ['grep -rn ada /d', 'decline', EVERY, '', true],
  ['grep -rv ada /d', 'both', null, '', true],
  ['rg --passthru ada /d', 'both', null, '', true],
  ["grep -r 'a.b' /d", 'both', null, '', true],
  ['rg -L ada /d', 'both', null, '', true],
  ['rg --files-without-match ada /d', 'both', null, '', true],
  ['rg -c --include-zero ada /d', 'both', null, '', true],
  ['rg --stats ada /d | head -2', 'both', EVERY, '', true],
  ['rg -z ada /d', 'both', EVERY, '', true],
  ["rg -U 'ada here\\nnothing' /d", 'both', EVERY, '', true],
  ['rg -U ada /d', 'lines', 'a.txt sub/d.txt', '', false],
  ['rg -q --files-without-match ada /d', 'files', null, 'ada', false],
  ['rg --files /d', 'both', '', '', false],
])('%s (%s) reads, asks and scans what it should', async (line, mount, reads, asked, scan) => {
  const vfs = new SearchRAM(MOUNTS[mount])
  expect(await run(vfs, line)).toEqual(await run(new RAMVFS(), line))
  const [text = '', word] = asked.split(' ')
  expect(vfs.asked).toEqual(text === '' ? [] : [[text, word !== undefined]])
  expect(vfs.scans).toEqual(scan ? ['/d'] : [])
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

// Twin of test_a_path_pinned_to_a_revision_is_always_read: a search sees the
// current content, so a pinned file is read whatever it answers.
it('always reads a path pinned to a revision', async () => {
  const vfs = new SearchRAM({ lines: null })
  const line = 'grep -r ada /d'
  expect(await run(vfs, line, undefined, { '/d/c.txt': 'r1' })).toEqual(
    await run(new RAMVFS(), line),
  )
  expect([...vfs.reads].sort()).toEqual(['d/a.txt', 'd/c.txt', 'd/sub/d.txt'])
})

async function grepAfterEdit(vfs: RAMVFS): Promise<[string, string[]]> {
  Object.assign(vfs, { cachesReads: true })
  for (const dir of ['/d', '/d/sub']) vfs.store.dirs.add(dir)
  for (const [key, data] of Object.entries({ ...TREE, '/d/c.txt': 'ada cached\n' })) {
    vfs.store.files.set(key, ENC.encode(data))
  }
  const ws = new Workspace({ '/': vfs }, { shellParser: await getTestParser() })
  try {
    await ws.shell('cat /d/c.txt')
    vfs.store.files.set('/d/c.txt', ENC.encode('nothing\n'))
    const reads = vfs instanceof SearchRAM ? vfs.reads : []
    reads.length = 0
    const out = await ws.shell('grep -rl ada /d')
    return [DEC.decode(out.stdout), [...reads].sort()]
  } finally {
    await ws.close()
  }
}

// Twin of test_a_cached_file_is_always_read: a search sees the current
// content and a read serves the cached copy, so a file edited since it was
// cached is read, not ruled out.
it('always reads a cached file', async () => {
  const [narrowed, reads] = await grepAfterEdit(new SearchRAM({ lines: null }))
  const [scanned] = await grepAfterEdit(new RAMVFS())
  expect([narrowed, scanned]).toEqual([
    '/d/a.txt\n/d/c.txt\n/d/sub/d.txt\n',
    '/d/a.txt\n/d/c.txt\n/d/sub/d.txt\n',
  ])
  expect(reads).toEqual(['d/a.txt', 'd/sub/d.txt'])
})

// Twin of test_a_hidden_path_is_walked_without_the_search.
// Twin of test_a_hidden_path_keeps_the_search_and_loses_its_hits: the
// dispatcher drops the hidden d.txt from the answer, so the search still
// narrows and the hidden file is never read.
it('keeps the search under a hide and loses its hits', async () => {
  const vfs = new SearchRAM()
  const line = 'grep -r ada /d'
  expect(await run(vfs, line, ['/d/sub'])).toEqual(await run(new RAMVFS(), line, ['/d/sub']))
  expect([vfs.asked, vfs.scans]).toEqual([[['ada', false]], []])
  expect(vfs.reads).not.toContain('d/sub/d.txt')
})

// Twin of test_a_hidden_operand_beside_a_visible_one_keeps_its_match: a mount
// with no search asks the scan guard for every operand; the hidden one reaches
// no directory, so the walk reports it as absent.
it.each(['grep -r ada', 'rg ada'])('%s keeps a match beside a hidden operand', async (line) => {
  const [out, err] = await run(new RAMVFS(), `${line} /d/a.txt /d/b.txt`, ['/d/b.txt'])
  expect(out).toBe('/d/a.txt:ada here\n')
  expect(err).toContain('/d/b.txt')
})

// Twin of test_a_path_rule_below_the_walk_keeps_greps_answer: the dispatcher
// asks no search below the rule and judges each line search as a read of its
// file, so a sealed file is reported as the plain walk reports it.
it.each(['grep -r ada /d', 'grep -rn ada /d', 'grep -rl ada /d'])(
  "keeps grep's answer under a path rule below the walk: %s",
  async (line) => {
    const deny = ['/d/sub/*']
    expect(await run(new SearchRAM(), line, undefined, {}, deny)).toEqual(
      await run(new RAMVFS(), line, undefined, {}, deny),
    )
  },
)

// Twin of test_a_streamed_answer_is_pulled_as_far_as_needed.
it.each([
  ['grep -ri ada /d', true],
  ['grep -rin ada /d', false],
  ['grep -ril ada /d', false],
  ['grep -riq ada /d', false],
  ['rg -i ada /d', true],
  ['rg -iq ada /d', false],
] as const)('pulls a streamed answer as far as %s needs', async (line, pullsEveryLine) => {
  const vfs = new SearchRAM(MOUNTS.stream)
  await run(vfs, line)
  expect([vfs.pulled.includes('ada lovelace\n'), vfs.open]).toEqual([pullsEveryLine, 0])
})

// Twin of test_rg_closes_a_streamed_answer_it_stops_inside: rg -q stops on a
// long first line of a streamed answer, which it closes all the same.
it('closes a streamed answer rg stops inside', async () => {
  const vfs = new SearchRAM(MOUNTS.stream)
  vfs.store.dirs.add('/big')
  vfs.store.files.set('/big/x.txt', ENC.encode('ada'.repeat(50_000) + '\nada'.repeat(9) + '\n'))
  await run(vfs, 'rg -q ada /big/x.txt')
  expect([vfs.pulled.length, vfs.open]).toEqual([1, 0])
})

const REFUSED = 'grep: 6 files in scope, narrow the path\n'
const DENIED = EVERY.split(' ')
  .map((key) => `grep: /d/${key}: Permission denied\n`)
  .join('')
const plainError = (message: string): Error => new Error(message)
const fsError = (message: string): Error => eacces('/d', message)

// Twin of test_a_mount_may_refuse_a_full_scan.
it.each<[string, string, (message: string) => Error, [string, number] | null]>([
  ['grep -rv ada /d', 'both', plainError, [REFUSED, 1]],
  ['grep -r ada /d', 'decline', plainError, [REFUSED, 1]],
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
