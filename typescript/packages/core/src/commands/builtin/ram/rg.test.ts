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
const RAM_RG = RAM_COMMANDS.filter((c) => c.name === 'rg' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runRg(
  vfs: RAMVFS,
  texts: string[],
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ lines: string[]; out: string; exitCode: number }> {
  const cmd = RAM_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, texts, {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { lines: [], out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = stripped === '' ? [] : stripped.split('\n')
  return { lines, out: text, exitCode: ioResult.exitCode }
}

describe('rg', () => {
  it.each([
    [{}, ''],
    [{ H: true }, '/tmp/binary.txt:'],
    [{ args_I: true }, ''],
    [{ H: true, args_I: true }, ''],
  ])('keeps rg filename flags separate from grep binary flags: %j', async (flags, prefix) => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/binary.txt', ENC.encode('needle\0tail\n'))
    const r = await runRg(vfs, ['needle'], [PathSpec.fromStrPath('/tmp/binary.txt')], flags)
    expect(r.out).toBe(`${prefix}needle\0tail\n`)
    expect(r.exitCode).toBe(0)
  })

  it('-I keeps NUL-containing matches across multiple files', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('needle\0a\n'))
    vfs.store.files.set('/tmp/b.txt', ENC.encode('needle\0b\n'))
    const r = await runRg(
      vfs,
      ['needle'],
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
      { args_I: true },
    )
    expect(r.out).toBe('needle\0a\nneedle\0b\n')
    expect(r.exitCode).toBe(0)
  })

  it('matches basic pattern in single file', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('hello world\nfoo bar\nhello again\n'))
    const r = await runRg(vfs, ['hello'], [PathSpec.fromStrPath('/tmp/a.txt')])
    expect(r.lines).toContain('hello world')
    expect(r.lines).toContain('hello again')
    expect(r.lines).not.toContain('foo bar')
  })

  it('no match returns exit code 1', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('hello world\nfoo bar\n'))
    const r = await runRg(vfs, ['xyz'], [PathSpec.fromStrPath('/tmp/a.txt')])
    expect(r.exitCode).toBe(1)
  })

  it('-i ignores case', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('Hello World\nhello world\nHELLO\n'))
    const r = await runRg(vfs, ['hello'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      i: true,
    })
    expect(r.lines.length).toBe(3)
  })

  it('-v inverts match', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('hello\nworld\nhello again\n'))
    const r = await runRg(vfs, ['hello'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      v: true,
    })
    expect(r.lines).toEqual(['world'])
  })

  it('-c gives count only', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('foo\nbar\nfoo baz\n'))
    const r = await runRg(vfs, ['foo'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      c: true,
    })
    expect(r.lines).toEqual(['2'])
  })

  it('-c on a zero-match file omits the count and exits 1 (unlike grep -c)', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('foo\nbar\n'))
    const r = await runRg(vfs, ['zzz'], [PathSpec.fromStrPath('/tmp/a.txt')], { c: true })
    expect(r.lines).toEqual([])
    expect(r.exitCode).toBe(1)
  })

  it('-c across files lists only files with matches', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a.txt', ENC.encode('foo\nfoo\n'))
    vfs.store.files.set('/tmp/b.txt', ENC.encode('bar\n'))
    const r = await runRg(
      vfs,
      ['foo'],
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
      { c: true },
    )
    expect(r.lines).toEqual(['/tmp/a.txt:2'])
    expect(r.exitCode).toBe(0)
  })

  it('-n prepends line numbers in stdin mode', async () => {
    const vfs = new RAMVFS()
    const r = await runRg(vfs, ['foo'], [], { n: true }, ENC.encode('foo\nbar\nfoo baz\n'))
    expect(r.lines).toContain('1:foo')
    expect(r.lines).toContain('3:foo baz')
  })

  it('reads from stdin when no path', async () => {
    const vfs = new RAMVFS()
    const r = await runRg(vfs, ['foo'], [], {}, ENC.encode('foo\nbar\nfoo baz\n'))
    expect(r.lines).toContain('foo')
    expect(r.lines).toContain('foo baz')
  })

  it('-l files-only mode (via args_l)', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/sub')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('hello\n'))
    vfs.store.files.set('/tmp/sub/b.txt', ENC.encode('world\n'))
    const r = await runRg(vfs, ['hello'], [PathSpec.fromStrPath('/tmp')], {
      args_l: true,
    })
    expect(r.lines.some((l) => l.includes('/tmp/a.txt'))).toBe(true)
    expect(r.lines.some((l) => l.includes('/tmp/sub/b.txt'))).toBe(false)
  })

  it('missing pattern returns exit code 2', async () => {
    const vfs = new RAMVFS()
    const r = await runRg(vfs, [], [])
    expect(r.exitCode).toBe(2)
  })
})
