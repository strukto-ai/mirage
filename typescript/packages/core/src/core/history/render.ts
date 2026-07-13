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

import type { EventDict } from '../../observe/observer.ts'
import { EVENT_COMMAND } from '../../observe/log_entry.ts'

const HISTSIZE = 500

/**
 * Render command events as a GNU bash histfile: one `#<epoch-seconds>`
 * timestamp comment line per entry followed by the command line.
 * Non-command events (ops, clear tombstones) are ignored.
 */
export function renderBashHistory(events: EventDict[]): string {
  const lines: string[] = []
  for (const e of events) {
    if (e.type !== EVENT_COMMAND) continue
    const ts = typeof e.timestamp === 'number' ? e.timestamp : 0
    lines.push(`#${String(Math.floor(ts / 1000))}`)
    lines.push(typeof e.command === 'string' ? e.command : '')
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

/**
 * Render command events as `history` command output: a numbered,
 * right-justified, two-space-separated listing.
 */
export function renderHistoryListing(
  events: EventDict[],
  n?: number,
  histsize: number = HISTSIZE,
): string {
  const commands = events.filter((e) => e.type === EVENT_COMMAND)
  const scoped = commands.slice(Math.max(0, commands.length - histsize))
  let entries: EventDict[]
  if (n === undefined || n < 0) {
    entries = scoped
  } else if (n > 0) {
    // bash lists nothing for n=0; slice(-0) would list everything.
    entries = scoped.slice(Math.max(0, scoped.length - n))
  } else {
    entries = []
  }
  const total = scoped.length
  const width = String(total).length
  const startIdx = total - entries.length + 1
  const lines = entries.map(
    (e, i) =>
      `${String(startIdx + i).padStart(width)}  ${typeof e.command === 'string' ? e.command : ''}`,
  )
  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}
