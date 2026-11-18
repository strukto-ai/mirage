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
import { bound, DIR, ROW, spec } from '../../../tests/fixtures/machine_files.ts'
import { FileType } from '../../types.ts'
import { rowStat, stat, tree } from './stat.ts'

const ENC = new TextEncoder()

function joined(...parts: (Uint8Array | string)[]): Uint8Array {
  return ENC.encode(
    parts.map((p) => (typeof p === 'string' ? p : new TextDecoder().decode(p))).join(''),
  )
}

describe('rowStat', () => {
  it("keeps the machine's kind, mode, times and owners", () => {
    const row = {
      kind: 'f',
      mode: 0o640,
      size: 12,
      mtimeMs: 1700000000123,
      atimeMs: 1700000001000,
      user: 'app',
      group: 'staff',
      rel: '',
    }
    const got = rowStat('x.py', row)
    expect([got.type, got.size, got.mode, got.uid, got.gid]).toEqual([
      FileType.FILE,
      12,
      0o640,
      'app',
      'staff',
    ])
    expect(got.modified).toBe('2023-11-14T22:13:20.123Z')
    expect(got.atime).toBe('2023-11-14T22:13:21.000Z')
  })

  it.each<[string, FileType, number | null]>([
    ['d', FileType.DIRECTORY, null],
    ['p', FileType.FIFO, null],
    ['c', FileType.CHAR_DEVICE, null],
    ['l', FileType.FILE, 7],
    ['s', FileType.FILE, 7],
  ])('maps %s', (kind, want, size) => {
    const got = rowStat('n', {
      kind,
      mode: 0o755,
      size: 7,
      mtimeMs: 0,
      atimeMs: 0,
      user: 'root',
      group: 'root',
      rel: '',
    })
    expect([got.type, got.size]).toEqual([want, size])
  })
})

describe('stat', () => {
  it('finds the path alone', async () => {
    const machine = new ScriptedMachine('box', () => ok(ROW))
    const got = await stat(bound([machine]), 'box', spec('/x.txt'))
    expect([got.name, got.size, got.uid]).toEqual(['x.txt', 3, 'root'])
    expect(machine.lines).toEqual([
      "env LC_ALL=C find -L '/tmp/x.txt' -maxdepth 0 -printf '%y %m %s %T@ %A@ %u %g %P\\0'",
    ])
  })

  it('is ENOENT for a missing path', async () => {
    const machine = new ScriptedMachine('box', () =>
      failed("find: '/tmp/x': No such file or directory\n"),
    )
    await expect(stat(bound([machine]), 'box', spec('/x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('tree', () => {
  it('merges every machine and leaves a failure to the walk', async () => {
    const a = new ScriptedMachine('a', () => ok(joined(DIR, 'f 644 1 0 0 r r x\0')))
    const b = new ScriptedMachine('b', () => ok(joined(DIR, 'f 644 2 0 0 r r y\0')))
    const rows = await tree(bound([a, b]), ['a', 'b'], spec('/d'))
    expect([...(rows?.keys() ?? [])].sort()).toEqual(['x', 'y'])
    const gone = new ScriptedMachine('gone', () => failed('find: lost\n'))
    expect(await tree(bound([a, gone]), ['a', 'gone'], spec('/d'))).toBeNull()
  })
})
