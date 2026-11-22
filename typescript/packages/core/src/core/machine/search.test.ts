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
import { ok, ScriptedMachine } from '../../../tests/fixtures/machine.ts'
import { bound, DIR, spec } from '../../../tests/fixtures/machine_files.ts'
import { filesContaining } from './search.ts'

const DEC = new TextDecoder()

/**
 * A machine whose grep names `matched` and whose find lists `held` under
 * the directory.
 */
function searched(name: string, matched: string, held: string): ScriptedMachine {
  return new ScriptedMachine(name, (line) =>
    line.includes(' find ') ? ok(DEC.decode(DIR) + held) : ok(matched),
  )
}

describe('filesContaining', () => {
  it('counts a match in an older copy as none', async () => {
    const a = searched(
      'a',
      '/tmp/d/x\0/tmp/d/only-a\0',
      'f 644 1 3 0 0 0 1 0 x\0f 644 1 3 0 0 0 1 0 only-a\0',
    )
    const b = searched('b', '', 'f 644 1 9 0 0 0 1 0 x\0')
    const found = await filesContaining(bound([a, b]), ['a', 'b'], spec('/d'), 'needle', false)
    expect(found?.map((p) => p.virtual)).toEqual(['/tmp/d/only-a'])
    expect(a.lines.filter((line) => line.includes(' find ')).length).toBe(1)
  })

  it("asks no listing for one machine's matches", async () => {
    const a = searched('a', '/tmp/d/x\0', '')
    const found = await filesContaining(bound([a]), ['a'], spec('/d'), 'needle', false)
    expect(found?.map((p) => p.virtual)).toEqual(['/tmp/d/x'])
    expect(a.lines.some((line) => line.includes(' find '))).toBe(false)
  })

  it('asks no listing when no machine matches', async () => {
    const a = searched('a', '', '')
    const b = searched('b', '', '')
    const found = await filesContaining(bound([a, b]), ['a', 'b'], spec('/d'), 'needle', false)
    expect(found).toEqual([])
    expect([...a.lines, ...b.lines].some((line) => line.includes(' find '))).toBe(false)
  })
})
