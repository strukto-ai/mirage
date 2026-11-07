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
import type { JsonObject } from '@struktoai/mirage-core/types'
import { completedLogs, logLines, logPage } from './logs.ts'

describe('command logs', () => {
  it('pages timestamp ties without returning unfinished commands', () => {
    const records: JsonObject[] = []
    for (const id of ['a', 'c', 'b']) {
      records.push({ type: 'command', id, command: id, session: 's', timestamp: 1000 })
      if (id !== 'c')
        records.push({
          type: 'result',
          parent: id,
          session: 's',
          timestamp: 1010,
          duration_ms: 10,
          exit_code: 0,
          stdout: '',
          stderr: '',
        })
    }
    const logs = completedLogs(records)
    const first = logPage(logs, '1')
    expect(first.items.map((item) => item.id)).toEqual(['b'])
    expect(first.next).not.toBeNull()
    const second = logPage(logs, '1', first.next ?? '')
    expect(second.items.map((item) => item.id)).toEqual(['a'])
    expect(second.next).toBeNull()
    const exported = [...logLines(logs)].map(
      (line) => JSON.parse(line) as { type: string; id?: string },
    )
    expect(exported.filter((event) => event.type === 'command').map((event) => event.id)).toEqual([
      'a',
      'b',
    ])
  })

  it.each(['bad', 'WzAsdHJ1ZV0=', 'e30=', 'bnVsbA==', 'WzBd'])(
    'refuses malformed cursor %s',
    (cursor) => {
      expect(() => logPage([], '50', cursor)).toThrow('after is not a cursor')
    },
  )
})
