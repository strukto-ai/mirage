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
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

describe('a line of several commands', () => {
  function build(): Workspace {
    return new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  }

  it('records each command read with what it wrote', async () => {
    const ws = build()
    const io = await ws.shell('echo a\nfor i in 1 2\ndo echo $i\ndone\n# done\nfalse\n')
    expect(DEC.decode(io.stdout)).toBe('a\n1\n2\n')
    const history = await ws.history()
    expect(
      history.map((e) => (e.type === 'command' ? e.command : [e.stdout, e.exit_code])),
    ).toEqual([
      'echo a',
      ['a\n', 0],
      'for i in 1 2; do echo $i; done',
      ['1\n2\n', 0],
      '# done',
      ['', 0],
      'false',
      ['', 1],
    ])
    const commands = history.filter((e) => e.type === 'command')
    const results = history.filter((e) => e.type === 'result')
    expect(results.map((e) => e.parent)).toEqual(commands.map((e) => e.id))
    expect(new Set(commands.map((e) => e.id)).size).toBe(4)
    await ws.close()
  })

  it('lists each in history and reads no further than an exit', async () => {
    const ws = build()
    await ws.shell('echo a\nexit 3\necho b\n')
    const io = await ws.shell('history')
    expect(DEC.decode(io.stdout)).toBe('1  echo a\n2  exit 3\n')
    await ws.close()
  })

  it('records a line it refuses as typed', async () => {
    const ws = build()
    await ws.shell('echo a\nif then\n')
    const history = await ws.history()
    expect(history.filter((e) => e.type === 'command').map((e) => e.command)).toEqual([
      'echo a',
      'if then',
    ])
    await ws.close()
  })

  it('records a line of one command whole', async () => {
    const ws = build()
    await ws.shell('cat <<A\nx\nA\n')
    const history = await ws.history()
    expect(history.map((e) => e.command ?? e.stdout)).toEqual(['cat <<A\nx\nA\n', 'x\n'])
    await ws.close()
  })
})
