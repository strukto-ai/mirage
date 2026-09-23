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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_FIND = RAM_COMMANDS.filter((c) => c.name === 'find' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runFind(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  texts: string[] = [],
): Promise<{ lines: string[]; exitCode: number; runs: PathSpec[][] | null }> {
  const cmd = RAM_FIND[0]
  if (cmd === undefined) throw new Error('find not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { lines: [], exitCode: -1, runs: null }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  return { lines, exitCode: ioResult.exitCode, runs: ioResult.matchedRuns }
}

describe('find', () => {
  it('lists all files recursively', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('hello'))
    vfs.store.files.set('/tmp/b.txt', ENC.encode('world'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toContain('/tmp/a.txt')
    expect(r.lines).toContain('/tmp/b.txt')
  })

  it('includes subdirectories', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/sub')
    vfs.store.files.set('/tmp/sub/c.txt', ENC.encode('nested'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')])
    expect(r.lines).toContain('/tmp/sub')
    expect(r.lines).toContain('/tmp/sub/c.txt')
  })

  it('-name glob pattern', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('aaa'))
    vfs.store.files.set('/tmp/b.py', ENC.encode('bbb'))
    vfs.store.files.set('/tmp/c.txt', ENC.encode('ccc'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { name: '*.txt' })
    const sorted = r.lines.slice().sort()
    expect(sorted).toEqual(['/tmp/a.txt', '/tmp/c.txt'])
  })

  it('-type d finds only directories', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/sub')
    vfs.store.files.set('/tmp/file.txt', ENC.encode('data'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { type: 'd' })
    expect(r.lines).toEqual(['/tmp', '/tmp/sub'])
  })

  it('-type f finds only files', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/sub')
    vfs.store.files.set('/tmp/file.txt', ENC.encode('data'))
    vfs.store.files.set('/tmp/sub/nested.py', ENC.encode('code'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { type: 'f' })
    const sorted = r.lines.slice().sort()
    expect(sorted).toEqual(['/tmp/file.txt', '/tmp/sub/nested.py'])
  })

  it('-size +N filters by min size', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/small.txt', ENC.encode('hi'))
    vfs.store.files.set('/tmp/big.txt', ENC.encode('a'.repeat(100)))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { size: '+50c' })
    expect(r.lines).toEqual(['/tmp/big.txt'])
  })

  it('-size -N filters by max size', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/small.txt', ENC.encode('hi'))
    vfs.store.files.set('/tmp/big.txt', ENC.encode('a'.repeat(100)))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { size: '-50c' })
    expect(r.lines).toEqual(['/tmp', '/tmp/small.txt'])
  })

  it('-maxdepth limits recursion', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/d1')
    vfs.store.dirs.add('/tmp/d1/d2')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('a'))
    vfs.store.files.set('/tmp/d1/b.txt', ENC.encode('b'))
    vfs.store.files.set('/tmp/d1/d2/c.txt', ENC.encode('c'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { maxdepth: '1' })
    expect(r.lines).toContain('/tmp/a.txt')
    expect(r.lines).toContain('/tmp/d1')
    expect(r.lines).not.toContain('/tmp/d1/d2/c.txt')
  })

  it('-not -name excludes matching', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('aaa'))
    vfs.store.files.set('/tmp/b.pyc', ENC.encode('bbb'))
    vfs.store.files.set('/tmp/c.txt', ENC.encode('ccc'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], {}, ['-not', '-name', '*.pyc'])
    const sorted = r.lines.slice().sort()
    expect(sorted).toEqual(['/tmp', '/tmp/a.txt', '/tmp/c.txt'])
  })

  it('-empty matches empty files and dirs', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/sub')
    vfs.store.dirs.add('/tmp/emptydir')
    vfs.store.files.set('/tmp/empty.txt', new Uint8Array())
    vfs.store.files.set('/tmp/sub/full.txt', ENC.encode('x'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { empty: true })
    expect(r.lines.slice().sort()).toEqual(['/tmp/empty.txt', '/tmp/emptydir'])
  })

  it('-empty with -type d', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/emptydir')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('x'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], { empty: true, type: 'd' })
    expect(r.lines.slice().sort()).toEqual(['/tmp/emptydir'])
  })

  it('-not -name excludes (B3 grammar)', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('a'))
    vfs.store.files.set('/tmp/b.md', ENC.encode('b'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], {}, ['-not', '-name', '*.txt'])
    expect(r.lines.slice().sort()).toEqual(['/tmp', '/tmp/b.md'])
  })

  it('-name a -o -name b (B3 grammar)', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('a'))
    vfs.store.files.set('/tmp/b.md', ENC.encode('b'))
    vfs.store.files.set('/tmp/c.rst', ENC.encode('c'))
    const r = await runFind(vfs, [PathSpec.fromStrPath('/tmp')], {}, [
      '-name',
      '*.txt',
      '-o',
      '-name',
      '*.md',
    ])
    expect(r.lines.slice().sort()).toEqual(['/tmp/a.txt', '/tmp/b.md'])
  })

  it('missing path yields no results', async () => {
    const vfs = new RAMVFS()
    const r = await runFind(vfs, [PathSpec.fromStrPath('/nonexistent')])
    expect(r.lines).toEqual([])
  })
})

describe('find -printf', () => {
  // The action layer renders -printf per row, beside the other actions,
  // so the handler hands back the rows as selected: one run per start
  // point, empty for one that is missing, the run a row's %P and %d are
  // measured from.
  it('hands the rows back unrendered, one run per start point', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/data')
    vfs.store.dirs.add('/data/sub')
    vfs.store.files.set('/data/a.txt', ENC.encode('hello\n'))
    vfs.store.files.set('/data/sub/b.txt', ENC.encode('hi\n'))
    const { lines, runs } = await runFind(
      vfs,
      [
        PathSpec.fromStrPath('/data'),
        PathSpec.fromStrPath('/nope'),
        PathSpec.fromStrPath('/data/sub'),
      ],
      {},
      ['-type', 'f', '-printf', '%f %s\\n'],
    )
    expect(lines).toEqual(['/data/a.txt', '/data/sub/b.txt', '/data/sub/b.txt'])
    expect(runs?.map((run) => run.map((p) => p.virtual))).toEqual([
      ['/data/a.txt', '/data/sub/b.txt'],
      [],
      ['/data/sub/b.txt'],
    ])
  })
})
