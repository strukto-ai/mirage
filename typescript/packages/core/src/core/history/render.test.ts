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
import type { EventDict } from '../../observe/observer.ts'
import { renderBashHistory, renderHistoryListing } from './render.ts'

function command(cmd: string, timestamp = 0): EventDict {
  return { type: 'command', command: cmd, timestamp }
}

describe('renderBashHistory', () => {
  it('emits GNU histfile format', () => {
    const events: EventDict[] = [
      { type: 'command', session: 's1', timestamp: 1718000000000, command: 'ls /data' },
      { type: 'command', session: 's2', timestamp: 1718000001000, command: 'cat /data/a.txt' },
    ]
    expect(renderBashHistory(events)).toBe('#1718000000\nls /data\n#1718000001\ncat /data/a.txt\n')
  })

  it('ignores non-command events', () => {
    const events: EventDict[] = [
      { type: 'clear', session: 's1', timestamp: 1000 },
      { type: 'vfs', session: 's1', timestamp: 2000, vfs: 'read' },
    ]
    expect(renderBashHistory(events)).toBe('')
  })
})

describe('renderHistoryListing', () => {
  it('numbers entries right-justified to the total width', () => {
    const events = Array.from({ length: 12 }, (_, i) => command(`cmd ${String(i)}`, i))
    const lines = renderHistoryListing(events).trimEnd().split('\n')
    expect(lines[0]).toBe(' 1  cmd 0')
    expect(lines[lines.length - 1]).toBe('12  cmd 11')
  })

  it('lists only the last n', () => {
    const events = Array.from({ length: 5 }, (_, i) => command(`c${String(i)}`))
    expect(renderHistoryListing(events, 2)).toBe('4  c3\n5  c4\n')
  })

  it('lists nothing for n=0', () => {
    const events = Array.from({ length: 5 }, (_, i) => command(`c${String(i)}`))
    expect(renderHistoryListing(events, 0)).toBe('')
  })

  it('caps at histsize', () => {
    const events = Array.from({ length: 600 }, (_, i) => command(`c${String(i)}`))
    const lines = renderHistoryListing(events).trimEnd().split('\n')
    expect(lines).toHaveLength(500)
    expect(lines[0]).toBe('  1  c100')
    expect(lines[lines.length - 1]).toBe('500  c599')
  })

  it('renders nothing for an empty history', () => {
    expect(renderHistoryListing([])).toBe('')
  })
})
