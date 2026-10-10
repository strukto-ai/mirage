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
import { ScanReason } from '../../../vfs/types.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { parseSessionProfile } from '../../../policy/profile.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import type { PathSpec } from '../../../types.ts'
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
  "echo 'x ada' | grep ada - /d/c.txt",
  "echo 'x ada' | rg ada - /d",
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
