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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

// Pinned on util-linux 2.41.5.
describe('colrm', () => {
  it.each([
    ["printf 'abcdefgh\\n' | colrm 3 5", 'abfgh\n', '', 0],
    ["printf 'abcdefgh\\n' | colrm 3", 'ab\n', '', 0],
    ["printf 'abcdefgh\\n' | colrm", 'abcdefgh\n', '', 0],
    ["printf 'a\\tb\\n' | colrm 2 3", 'a     b\n', '', 0],
    ["printf 'abc\\n' | colrm x", '', "colrm: first argument: 'x'\n", 1],
    ["printf 'abc\\n' | colrm 1 x", '', "colrm: second argument: 'x'\n", 1],
    [
      "printf 'a\\377b\\n' | colrm 1",
      '',
      'colrm: fgetwc() failed: Invalid or incomplete multibyte or wide character\n',
      1,
    ],
  ])('%s', async (line, stdout, stderr, code) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([stdout, stderr, code])
  })
})

async function* arriving(parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve()
    yield part
  }
}

describe('colrm across chunks', () => {
  it.each([
    [
      [
        [0x78, 0xc3],
        [0xa9, 0x79, 0x0a],
      ],
      2,
      2,
      [0x78, 0x79, 0x0a],
      0,
    ],
    [[[0x78, 0xe2], [0x82], [0xac, 0x79, 0x0a]], 2, 2, [0x78, 0x79, 0x0a], 0],
    [[[0x61, 0xc3]], 2, null, [0x61], 0],
    [[[0x61, 0xc3], [0x62]], 2, null, [0x61], 1],
  ])('%j', async (parts, start, stop, stdout, code) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const args = stop === null ? String(start) : `${String(start)} ${String(stop)}`
    const io = await ws.shell(`colrm ${args}`, {
      stdin: arriving(parts.map((part) => Uint8Array.from(part))),
      env: { LC_ALL: 'C.UTF-8' },
    })
    expect([...io.stdout]).toEqual(stdout)
    expect(io.exitCode).toBe(code)
    await ws.close()
  })
})

it('records invalid input before an early reader closes', async () => {
  const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
  const io = await ws.shell("set -o pipefail; printf 'ab\\377' | LC_ALL=C colrm 3 | head -c 1")
  expect(io.stdoutText).toBe('a')
  expect(io.exitCode).toBe(1)
  expect(io.stderrText).toContain('Invalid or incomplete multibyte')
  await ws.close()
})
