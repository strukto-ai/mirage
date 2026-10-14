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
import { EVENT_COMMAND, LogEntry } from './log_entry.ts'
import { OpRecord } from './record.ts'

function commandEntry(cwd?: string): LogEntry {
  return new LogEntry({
    type: EVENT_COMMAND,
    session: 's',
    timestamp: 1000,
    ...(cwd !== undefined ? { cwd } : {}),
    command: 'ls',
    exitCode: 0,
    stdout: 'out',
  })
}

describe('LogEntry.fromOpRecord', () => {
  it('copies fields from an OpRecord with session', () => {
    const rec = new OpRecord({
      op: 'read',
      path: '/data/file.csv',
      source: 's3',
      bytes: 1024,
      timestamp: 1712145600000,
      durationMs: 45,
    })
    const entry = LogEntry.fromOpRecord(rec, 'sess-1')
    expect(entry.type).toBe('op')
    expect(entry.session).toBe('sess-1')
    expect(entry.op).toBe('read')
    expect(entry.path).toBe('/data/file.csv')
    expect(entry.source).toBe('s3')
    expect(entry.bytes).toBe(1024)
    expect(entry.durationMs).toBe(45)
  })
})

describe('LogEntry.toJsonLine', () => {
  it('emits only op fields for an op entry (no command key)', () => {
    const rec = new OpRecord({
      op: 'read',
      path: '/f.csv',
      source: 's3',
      bytes: 100,
      timestamp: 1000,
      durationMs: 5,
    })
    const entry = LogEntry.fromOpRecord(rec, 's')
    const parsed = JSON.parse(entry.toJsonLine()) as Record<string, unknown>
    expect(parsed.type).toBe('op')
    expect(parsed.op).toBe('read')
    expect(parsed).not.toHaveProperty('command')
  })

  it('emits only command fields for a command entry (no op key)', () => {
    const entry = commandEntry()
    const parsed = JSON.parse(entry.toJsonLine()) as Record<string, unknown>
    expect(parsed.type).toBe('command')
    expect(parsed.command).toBe('ls')
    expect(parsed).not.toHaveProperty('op')
  })

  it('includes cwd when provided for op entries', () => {
    const rec = new OpRecord({
      op: 'read',
      path: '/f.csv',
      source: 's3',
      bytes: 100,
      timestamp: 1000,
      durationMs: 5,
    })
    const entry = LogEntry.fromOpRecord(rec, 's', '/data')
    const parsed = JSON.parse(entry.toJsonLine()) as Record<string, unknown>
    expect(parsed.cwd).toBe('/data')
  })

  it('includes cwd when provided for command entries', () => {
    const parsed = JSON.parse(commandEntry('/data').toJsonLine()) as Record<string, unknown>
    expect(parsed.cwd).toBe('/data')
  })

  it('omits cwd when not provided', () => {
    const rec = new OpRecord({
      op: 'read',
      path: '/f.csv',
      source: 's3',
      bytes: 100,
      timestamp: 1000,
      durationMs: 5,
    })
    const entry = LogEntry.fromOpRecord(rec, 's')
    const parsed = JSON.parse(entry.toJsonLine()) as Record<string, unknown>
    expect(parsed).not.toHaveProperty('cwd')
  })
})
