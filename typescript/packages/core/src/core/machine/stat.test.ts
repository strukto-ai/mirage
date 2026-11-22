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
import { bound, ROW, spec } from '../../../tests/fixtures/machine_files.ts'
import { FileType } from '../../types.ts'
import { entryStat, leaf, stat } from './stat.ts'

describe('entryStat', () => {
  it("keeps the machine's kind, mode, times and owners", () => {
    const entry = {
      kind: 'f',
      mode: 0o640,
      size: 12,
      mtime: 1700000000,
      atime: 1700000001,
      mtimeMs: 1700000000123,
      atimeMs: 1700000001000,
      uid: 1000,
      gid: 50,
      nlink: 1,
      blocks: 8,
      rel: '',
    }
    const got = entryStat('x.py', entry)
    expect([got.type, got.size, got.mode, got.uid, got.gid]).toEqual([
      FileType.FILE,
      12,
      0o640,
      1000,
      50,
    ])
    expect(got.modified).toBe('2023-11-14T22:13:20.123Z')
    expect(got.atime).toBe('2023-11-14T22:13:21.000Z')
    expect([got.nlink, got.blocks]).toEqual([1, 8])
  })

  it.each<[string, FileType, number | null]>([
    ['d', FileType.DIRECTORY, null],
    ['p', FileType.FIFO, null],
    ['c', FileType.CHAR_DEVICE, null],
    ['l', FileType.FILE, 7],
    ['s', FileType.FILE, 7],
  ])('maps %s', (kind, want, size) => {
    const got = entryStat('n', {
      kind,
      mode: 0o755,
      size: 7,
      mtime: 0,
      atime: 0,
      mtimeMs: 0,
      atimeMs: 0,
      uid: 0,
      gid: 0,
      nlink: 1,
      blocks: 0,
      rel: '',
    })
    expect([got.type, got.size]).toEqual([want, size])
  })
})

describe('stat', () => {
  it('finds the path alone', async () => {
    const machine = new ScriptedMachine('box', () => ok(ROW))
    const got = await stat(bound([machine]), 'box', spec('/x.txt'))
    expect([got.name, got.size, got.uid]).toEqual(['x.txt', 3, 0])
    expect(machine.lines).toEqual([
      "env LC_ALL=C find -L '/tmp/x.txt' -maxdepth 0 -printf '%y %m %s %T@ %A@ %U %G %n %b %P\\0'",
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

describe('leaf', () => {
  it('names the last part and the root', () => {
    expect(leaf(spec('/d/x.txt'))).toBe('x.txt')
    expect(leaf(spec(''))).toBe('/')
  })
})
