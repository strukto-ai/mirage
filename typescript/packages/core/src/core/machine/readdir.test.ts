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

import { describe, expect, it } from 'vitest'
import { failed, ok, ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import { bound, DIR, spec } from '../../../tests/fixtures/machine_files.ts'
import { bindCaller, currentCaller } from '../../context/session_context.ts'
import { PathSpec } from '../../types.ts'
import { readdir, tree } from './readdir.ts'

const MISSING = "find: '/tmp/d': No such file or directory\n"
const DEC = new TextDecoder()

function listing(...names: string[]): string {
  return DEC.decode(DIR) + names.map((n) => `f 644 1 0 0 0 0 1 0 ${n}\0`).join('')
}

describe('readdir', () => {
  it('lists each name once for a directory on two machines', async () => {
    const a = new ScriptedMachine('a', () => ok(listing('out.csv')))
    const b = new ScriptedMachine('b', () => ok(listing('out.csv', 'model.bin')))
    const names = (await readdir(bound([a, b]), ['a', 'b'], spec('/d'))).map((s) => s.name)
    expect(names).toEqual(['model.bin', 'out.csv'])
    expect(a.lines[0]?.endsWith("-maxdepth 1 -printf '%y %m %s %T@ %A@ %U %G %n %b %P\\0'")).toBe(
      true,
    )
  })

  it('lists a directory only one machine has there', async () => {
    const a = new ScriptedMachine('a', () => failed(MISSING))
    const b = new ScriptedMachine('b', () => ok(listing('x')))
    const names = (await readdir(bound([a, b]), ['a', 'b'], spec('/d'))).map((s) => s.name)
    expect(names).toEqual(['x'])
  })

  it('is ENOENT with no machine holding it and ENOTDIR for a file', async () => {
    const a = new ScriptedMachine('a', () => failed(MISSING))
    await expect(readdir(bound([a]), ['a'], spec('/d'))).rejects.toMatchObject({ code: 'ENOENT' })
    const f = new ScriptedMachine('f', () => ok('f 644 1 0 0 0 0 1 0 \0'))
    await expect(readdir(bound([a, f]), ['a', 'f'], spec('/d'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('fails the listing when a machine cannot list it', async () => {
    const a = new ScriptedMachine('a', () => failed("find: '/tmp/d': Permission denied\n"))
    const b = new ScriptedMachine('b', () => ok(listing('x')))
    await expect(readdir(bound([a, b]), ['a', 'b'], spec('/d'))).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  it('lists the copy written last for a name on two machines', async () => {
    const a = new ScriptedMachine('a', () =>
      ok(
        DEC.decode(DIR) +
          'f 644 1 1700000009 0 0 0 1 0 out.csv\0f 644 5 1700000000 0 0 0 1 0 log\0',
      ),
    )
    const b = new ScriptedMachine('b', () =>
      ok(
        DEC.decode(DIR) +
          'f 644 2 1700000000 0 0 0 1 0 out.csv\0d 755 4096 1700000004 0 0 0 2 8 log\0',
      ),
    )
    for (const accessor of [bound([a, b]), bound([b, a])]) {
      const found = await readdir(accessor, accessor.names(), spec('/d'))
      expect(found.map((s) => [s.name, s.size])).toEqual([
        ['log', null],
        ['out.csv', 1],
      ])
    }
  })

  it("lists the command's machine's copy of copies written together", async () => {
    const a = new ScriptedMachine('a', () => ok(DEC.decode(DIR) + 'f 644 1 5 0 0 0 1 0 x\0'))
    const b = new ScriptedMachine('b', () => ok(DEC.decode(DIR) + 'f 644 2 5 0 0 0 1 0 x\0'))
    const accessor = bound([a, b])
    expect((await readdir(accessor, ['a', 'b'], spec('/d'))).map((s) => s.size)).toEqual([1])
    await bindCaller({ ...currentCaller(), preferredMachine: 'b' }, async () => {
      expect((await readdir(accessor, ['a', 'b'], spec('/d'))).map((s) => s.size)).toEqual([2])
    })
  })

  it("does not list a newer file over another machine's folder", async () => {
    const a = new ScriptedMachine('a', () => ok(listing('in')))
    const newer = new ScriptedMachine('newer', () => ok('f 644 1 1700000009 0 0 0 1 0 \0'))
    await expect(readdir(bound([a, newer]), ['a', 'newer'], spec('/d'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    const older = new ScriptedMachine('older', () => ok('f 644 1 5 0 0 0 1 0 \0'))
    const found = await readdir(bound([a, older]), ['a', 'older'], spec('/d'))
    expect(found.map((s) => s.name)).toEqual(['in'])
  })
})

describe('tree', () => {
  it('merges every machine and leaves a failure to the walk', async () => {
    const a = new ScriptedMachine('a', () =>
      ok(DEC.decode(DIR) + 'f 644 1 0 0 0 0 1 0 x\0f 644 1 7 0 0 0 1 0 s/both\0'),
    )
    const b = new ScriptedMachine('b', () =>
      ok(DEC.decode(DIR) + 'f 644 2 0 0 0 0 1 0 y\0f 644 2 9 0 0 0 1 0 s/both\0'),
    )
    const found = await tree(bound([a, b]), ['a', 'b'], spec('/d'))
    expect([...(found?.keys() ?? [])].sort()).toEqual(['s/both', 'x', 'y'])
    expect([found?.get('s/both')?.machine, found?.get('s/both')?.written]).toEqual(['b', 9000])
    const gone = new ScriptedMachine('gone', () => failed('find: lost\n'))
    expect(await tree(bound([a, gone]), ['a', 'gone'], spec('/d'))).toBeNull()
  })

  it('lists nothing below a name whose copy shown is a file', async () => {
    const a = new ScriptedMachine('a', () =>
      ok(
        DEC.decode(DIR) +
          'd 755 4096 3 0 0 0 2 8 x\0f 644 1 3 0 0 0 1 0 x/y\0f 644 1 3 0 0 0 1 0 z\0',
      ),
    )
    const b = new ScriptedMachine('b', () => ok(DEC.decode(DIR) + 'f 644 2 9 0 0 0 1 0 x\0'))
    const found = await tree(bound([a, b]), ['a', 'b'], spec('/d'))
    expect([...(found?.keys() ?? [])].sort()).toEqual(['x', 'z'])
    expect(found?.get('x')?.machine).toBe('b')
  })

  it("lists a kernel's view as the command's machine has it", async () => {
    const a = new ScriptedMachine('a', () =>
      ok(DEC.decode(DIR) + 'd 555 0 3 0 0 0 2 0 proc\0f 444 1 3 0 0 0 1 0 proc/uptime\0'),
    )
    const b = new ScriptedMachine('b', () =>
      ok(
        DEC.decode(DIR) +
          'd 555 0 9 0 0 0 7 0 proc\0f 444 2 9 0 0 0 1 0 proc/uptime\0' +
          'f 444 2 9 0 0 0 1 0 proc/only-b\0',
      ),
    )
    const accessor = bound([a, b], { root: '/' })
    const root = PathSpec.fromStrPath('/', '')
    const listed = await readdir(accessor, ['a', 'b'], root)
    expect(listed.filter((s) => s.name === 'proc').map((s) => [s.name, s.nlink])).toEqual([
      ['proc', 2],
    ])
    const found = await tree(accessor, ['a', 'b'], root)
    expect([...(found?.keys() ?? [])].sort()).toEqual(['proc', 'proc/uptime'])
    expect(found?.get('proc/uptime')?.machine).toBe('a')
    await bindCaller({ ...currentCaller(), preferredMachine: 'b' }, async () => {
      const from = await tree(accessor, ['a', 'b'], root)
      expect([...(from?.keys() ?? [])].sort()).toEqual(['proc', 'proc/only-b', 'proc/uptime'])
    })
  })
})
