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
import { HISTORY_MAX_RECORDS } from '../constants.ts'
import { LineId } from '../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { LineHandle } from './handle.ts'
import { LineTable } from './table.ts'

function line(table: LineTable, name: string, sessionId = 's'): LineHandle {
  const handle = new LineHandle(new LineId(name), sessionId, name, undefined, () =>
    table.clock.now(),
  )
  table.start(handle)
  return handle
}

describe('LineTable', () => {
  it('lists lines by session', () => {
    const table = new LineTable(new ManualClock())
    const first = line(table, 'a', 's1')
    line(table, 'b', 's2')
    expect(table.lines().map((l) => l.id.value)).toEqual(['a', 'b'])
    expect(table.lines('s1').map((l) => l.id.value)).toEqual(['a'])
    expect(table.get(new LineId('a'))).toBe(first.record)
    expect(table.get(new LineId('missing'))).toBeNull()
  })

  it('keeps only the newest ended lines', () => {
    const clock = new ManualClock()
    const table = new LineTable(clock)
    const running = line(table, 'running')
    for (let index = 0; index <= HISTORY_MAX_RECORDS; index += 1) {
      line(table, `l${String(index)}`).end(0)
      clock.advance(0.001)
    }
    const ids = table.lines().map((l) => l.id.value)
    expect(ids.length).toBe(HISTORY_MAX_RECORDS + 1)
    expect(ids[0]).toBe(running.id.value)
    expect(ids).not.toContain('l0')
    expect(ids.at(-1)).toBe(`l${String(HISTORY_MAX_RECORDS)}`)
  })

  it('lets ended lines go after an hour', () => {
    const clock = new ManualClock()
    const table = new LineTable(clock)
    const handle = line(table, 'a')
    handle.end(0)
    clock.advance(3601)
    expect(table.get(handle.id)).toBeNull()
  })
})
