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
import { readdir } from './readdir.ts'

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
})
