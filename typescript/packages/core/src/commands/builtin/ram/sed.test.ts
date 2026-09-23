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
const RAM_SED = RAM_COMMANDS.filter((c) => c.name === 'sed' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runSed(
  vfs: RAMVFS,
  texts: string[],
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<string> {
  const cmd = RAM_SED[0]
  if (cmd === undefined) throw new Error('sed not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, texts, {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('sed -f', () => {
  it('reads the script from a file', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/prog.sed', ENC.encode('s/hello/HI/\n'))
    vfs.store.files.set('/tmp/in.txt', ENC.encode('hello world\n'))
    const out = await runSed(vfs, [], [PathSpec.fromStrPath('/tmp/in.txt')], {
      f: ['/tmp/prog.sed'],
    })
    expect(out).toBe('HI world\n')
  })

  it('applies multiple commands from the script file', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/prog.sed', ENC.encode('s/hello/HI/\ns/world/EARTH/\n'))
    vfs.store.files.set('/tmp/in.txt', ENC.encode('hello world\n'))
    const out = await runSed(vfs, [], [PathSpec.fromStrPath('/tmp/in.txt')], {
      f: ['/tmp/prog.sed'],
    })
    expect(out).toBe('HI EARTH\n')
  })

  it('combines -e and -f (e then f)', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/prog.sed', ENC.encode('s/world/EARTH/\n'))
    vfs.store.files.set('/tmp/in.txt', ENC.encode('hello world\n'))
    const out = await runSed(vfs, [], [PathSpec.fromStrPath('/tmp/in.txt')], {
      e: 's/hello/HI/',
      f: ['/tmp/prog.sed'],
    })
    expect(out).toBe('HI EARTH\n')
  })

  it('reads the script file in stdin mode', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/prog.sed', ENC.encode('s/hello/HI/\n'))
    const out = await runSed(vfs, [], [], { f: ['/tmp/prog.sed'] }, ENC.encode('hello world\n'))
    expect(out).toBe('HI world\n')
  })
})

describe('sed -i beyond s and d', () => {
  it('c writes the changed text to the file', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('one\ntwo\n'))
    const out = await runSed(vfs, ['c chg'], [PathSpec.fromStrPath('/tmp/a.txt')], { i: true })
    expect(out).toBe('')
    expect(DEC.decode(vfs.store.files.get('/tmp/a.txt'))).toBe('chg\nchg\n')
  })

  it('i writes the inserted line to the file', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('one\ntwo\nthree\n'))
    const out = await runSed(vfs, ['2i inserted'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      i: true,
    })
    expect(out).toBe('')
    expect(DEC.decode(vfs.store.files.get('/tmp/a.txt'))).toBe('one\ninserted\ntwo\nthree\n')
  })

  it('p doubles every line in the file', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('one\ntwo\n'))
    const out = await runSed(vfs, ['p'], [PathSpec.fromStrPath('/tmp/a.txt')], { i: true })
    expect(out).toBe('')
    expect(DEC.decode(vfs.store.files.get('/tmp/a.txt'))).toBe('one\none\ntwo\ntwo\n')
  })

  it('q truncates the file at the quit line', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('one\ntwo\nthree\n'))
    const out = await runSed(vfs, ['2q'], [PathSpec.fromStrPath('/tmp/a.txt')], { i: true })
    expect(out).toBe('')
    expect(DEC.decode(vfs.store.files.get('/tmp/a.txt'))).toBe('one\ntwo\n')
  })

  it('y transliterates the file in place', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('one\ntwo\n'))
    const out = await runSed(vfs, ['y/o/0/'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      i: true,
    })
    expect(out).toBe('')
    expect(DEC.decode(vfs.store.files.get('/tmp/a.txt'))).toBe('0ne\ntw0\n')
  })
})

describe('sed multi-file output', () => {
  it('concatenates per-file output without a separator', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('A\n'))
    vfs.store.files.set('/tmp/b.txt', ENC.encode('B\n'))
    const out = await runSed(
      vfs,
      ['p'],
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
    )
    expect(out).toBe('A\nA\nB\nB\n')
  })
})
