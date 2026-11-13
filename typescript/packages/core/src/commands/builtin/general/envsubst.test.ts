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

// Pinned on gettext-runtime 0.23.1.
describe('envsubst', () => {
  it.each([
    ["printf 'a ${X} $$ $1 \\\\$X\\n' | X=val envsubst", 'a val $$ $1 \\val\n', '', 0],
    ["printf '$X $Y\\n' | X=1 Y=2 envsubst '$Y'", '$X 2\n', '', 0],
    ["printf '$NOPE!\\n' | envsubst", '!\n', '', 0],
    ["envsubst -v 'a $X ${Y} $X'", 'X\nY\nX\n', '', 0],
    ['envsubst -v', '', 'envsubst: missing arguments\n', 1],
    ['envsubst a b', '', 'envsubst: too many arguments\n', 1],
  ])('%s', async (line, stdout, stderr, code) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([stdout, stderr, code])
  })
})

it('preserves references split at every byte and raw environment values', async () => {
  const data = Uint8Array.from([...new TextEncoder().encode('${X} / $X / $MISSING / ${ / '), 255])
  const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
  for (let split = 0; split <= data.length; split++) {
    async function* source() {
      await Promise.resolve()
      yield data.subarray(0, split)
      yield data.subarray(split)
    }
    const io = await ws.shell('envsubst', { stdin: source(), env: { X: '\udcff' } })
    expect([...io.stdout]).toEqual([
      255, 32, 47, 32, 255, 32, 47, 32, 32, 47, 32, 36, 123, 32, 47, 32, 255,
    ])
    expect(io.exitCode).toBe(0)
  }
  await ws.close()
})

it('drains large expansions and lists variables without reading stdin', async () => {
  const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
  const io = await ws.shell('envsubst', {
    stdin: new TextEncoder().encode('${X}'),
    env: { X: 'z'.repeat(100000) },
  })
  expect(io.stdoutText).toBe('z'.repeat(100000))
  let reads = 0
  async function* source() {
    await Promise.resolve()
    reads++
    yield new Uint8Array()
  }
  const listed = await ws.shell("envsubst -v '$X ${Y} $X'", { stdin: source() })
  expect(listed.stdoutText).toBe('X\nY\nX\n')
  expect(reads).toBe(0)
  await ws.close()
})
