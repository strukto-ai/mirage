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
import { bound, spec } from '../../../tests/fixtures/machine_files.ts'
import { firstLines, lastLines, lineCount, read, readCommand } from './read.ts'

describe('readCommand', () => {
  it.each<[number, number | null, string]>([
    [0, null, "cat -- '/tmp/a b'"],
    [0, 5, "head -c 5 -- '/tmp/a b'"],
    [3, null, "tail -c +4 -- '/tmp/a b'"],
    [3, 5, "tail -c +4 -- '/tmp/a b' | head -c 5"],
  ])('prints the window at %d of %s', (offset, size, line) => {
    expect(readCommand('/tmp/a b', offset, size)).toBe(line)
  })
})

describe('read', () => {
  it('runs on the machine under the root', async () => {
    const machine = new ScriptedMachine('box', () => ok('bytes'))
    const accessor = bound([machine], { root: '/srv' })
    expect(new TextDecoder().decode(await read(accessor, 'box', spec('/x.txt'), 2, 3))).toBe(
      'bytes',
    )
    expect(machine.lines).toEqual(["tail -c +3 -- '/srv/x.txt' | head -c 3"])
  })

  it('raises what the tool said when it fails', async () => {
    const machine = new ScriptedMachine('box', () =>
      failed('cat: /tmp/x.txt: No such file or directory\n'),
    )
    await expect(read(bound([machine]), 'box', spec('/x.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('fails on a complaint though the line exits 0', async () => {
    const machine = new ScriptedMachine('box', () => ({
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode("tail: cannot open '/tmp/d' for reading: Is a directory\n"),
      exitCode: 0,
    }))
    await expect(read(bound([machine]), 'box', spec('/d'), 1, 1)).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })
})

describe('lines and counts', () => {
  it('run where the file is', async () => {
    const machine = new ScriptedMachine('box', () => ok('3\n'))
    const accessor = bound([machine])
    const path = spec('/x.txt')
    await firstLines(accessor, 'box', path, 2)
    await lastLines(accessor, 'box', path, 4)
    expect(await lineCount(accessor, 'box', path)).toBe(3)
    expect(machine.lines).toEqual([
      "head -n 2 -- '/tmp/x.txt'",
      "tail -n 4 -- '/tmp/x.txt'",
      "env LC_ALL=C wc -l < '/tmp/x.txt'",
    ])
  })
})
