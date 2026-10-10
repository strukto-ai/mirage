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

import { commandIo } from '../../commands/builtin/generic_bind/adapter.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../io/types.ts'
import { RAMVFS } from './ram.ts'
import { PathSpec } from '../../types.ts'
const RAM_SED = GENERIC_COMMANDS.filter((c) => c.name === 'sed' && c.filetype == null)

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
    io: commandIo(vfs),
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('sed -f', () => {
  // A script file runs whole, every command in it, after any -e.
  it.each([
    ['s/hello/HI/\ns/world/EARTH/\n', {}],
    ['s/world/EARTH/\n', { e: 's/hello/HI/' }],
  ])('runs the script file %j', async (script, extra) => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/prog.sed', ENC.encode(script))
    vfs.store.files.set('/tmp/in.txt', ENC.encode('hello world\n'))
    const out = await runSed(vfs, [], [PathSpec.fromStrPath('/tmp/in.txt')], {
      ...extra,
      f: ['/tmp/prog.sed'],
    })
    expect(out).toBe('HI EARTH\n')
  })
})

describe('sed -i beyond s and d', () => {
  it.each([
    ['2q', 'one\ntwo\n'],
    ['y/o/0/', '0ne\ntw0\nthree\n'],
  ])('%s rewrites the file in place', async (script, want) => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('one\ntwo\nthree\n'))
    const out = await runSed(vfs, [script], [PathSpec.fromStrPath('/tmp/a.txt')], { i: true })
    expect(out).toBe('')
    expect(DEC.decode(vfs.store.files.get('/tmp/a.txt'))).toBe(want)
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
