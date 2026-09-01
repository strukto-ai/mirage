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
import { IOResult } from '../io/types.ts'
import {
  activeLineId,
  record,
  recordStream,
  runWithMountPrefix,
  runWithRecording,
} from './context.ts'
import { EVENT_COMMAND, EVENT_OP, LogEntry } from './log_entry.ts'
import { Observer } from './observer.ts'
import { OpRecord } from './record.ts'
import { RAMObserverStore } from './store.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('line id on the recording scope', () => {
  it('is minted per scope and stamped on every record', async () => {
    const [, records, lineId] = await runWithRecording(() => {
      record('read', '/a.txt', 'ram', 3, performance.now())
      recordStream('read', '/b.txt', 'ram')
      return Promise.resolve()
    })
    expect(lineId).toMatch(UUID_RE)
    expect(records.map((r) => r.lineId)).toEqual([lineId, lineId])
  })

  it('differs between scopes', async () => {
    const [, , first] = await runWithRecording(() => Promise.resolve())
    const [, , second] = await runWithRecording(() => Promise.resolve())
    expect(first).not.toBe(second)
  })

  it('survives a mount-prefix push', async () => {
    const [, records, lineId] = await runWithRecording(async () => {
      await runWithMountPrefix('/s3', () => {
        record('read', '/a.txt', 's3', 3, performance.now())
        return Promise.resolve()
      })
    })
    expect(records[0]?.path).toBe('/s3/a.txt')
    expect(records[0]?.lineId).toBe(lineId)
  })

  it('is null outside any scope', () => {
    expect(activeLineId()).toBeNull()
    record('read', '/a.txt', 'ram', 3, performance.now())
  })
})

describe('line id on the wire', () => {
  it('rides fromOpRecord into the log entry and out as line_id', () => {
    const rec = new OpRecord({
      op: 'read',
      path: '/a.txt',
      source: 'ram',
      bytes: 3,
      timestamp: 1000,
      durationMs: 1,
      lineId: 'abc',
    })
    const entry = LogEntry.fromOpRecord(rec, 'agent', 'sess')
    expect(entry.lineId).toBe('abc')
    const line = JSON.parse(entry.toJsonLine()) as { line_id?: string }
    expect(line.line_id).toBe('abc')
  })

  it('is absent from the line when the record carries none', () => {
    const rec = new OpRecord({
      op: 'read',
      path: '/a.txt',
      source: 'ram',
      bytes: 3,
      timestamp: 1000,
      durationMs: 1,
    })
    const entry = LogEntry.fromOpRecord(rec, 'agent', 'sess')
    expect(entry.lineId).toBeUndefined()
    expect('line_id' in JSON.parse(entry.toJsonLine())).toBe(false)
  })
})

describe('Observer op views', () => {
  function opRecord(path: string, lineId: string): OpRecord {
    return new OpRecord({
      op: 'read',
      path,
      source: 'ram',
      bytes: 1,
      timestamp: 1000,
      durationMs: 0,
      lineId,
    })
  }

  it('opEvents returns only ops, and lineEvents joins them to their command', async () => {
    const o = new Observer(new RAMObserverStore())
    await o.logExecution(
      'cat /a.txt',
      new IOResult({ exitCode: 0 }),
      [opRecord('/a.txt', 'line-1')],
      'agent',
      'sess',
      '/',
      'line-1',
    )
    await o.logExecution(
      'cat /b.txt',
      new IOResult({ exitCode: 0 }),
      [opRecord('/b.txt', 'line-2')],
      'agent',
      'sess',
      '/',
      'line-2',
    )

    const ops = await o.opEvents()
    expect(ops.map((e) => e.path)).toEqual(['/a.txt', '/b.txt'])
    expect(ops.every((e) => e.type === EVENT_OP)).toBe(true)

    const line = await o.lineEvents('line-2')
    expect(line.map((e) => e.type)).toEqual([EVENT_OP, EVENT_COMMAND])
    expect(line[0]?.path).toBe('/b.txt')
    expect(line[1]?.command).toBe('cat /b.txt')
  })

  it('lineEvents is empty for an unknown or blank id', async () => {
    const o = new Observer(new RAMObserverStore())
    await o.logExecution('echo hi', new IOResult({ exitCode: 0 }), [], 'a', 's', '/', 'line-1')
    expect(await o.lineEvents('nope')).toEqual([])
    expect(await o.lineEvents('')).toEqual([])
  })
})
