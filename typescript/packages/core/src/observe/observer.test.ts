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
import { utcDateFolder } from '../utils/dates.ts'
import { EVENT_COMMAND, LogEntry } from './log_entry.ts'
import { Observer } from './observer.ts'
import { OpRecord } from './record.ts'
import { RAMObserverStore } from './store.ts'

function logEntry(o: Observer, entry: LogEntry): Promise<void> {
  return (o as unknown as { log: (e: LogEntry) => Promise<void> }).log(entry)
}

function logCommand(o: Observer, command: string, session: string, ts: number): Promise<void> {
  return logEntry(
    o,
    new LogEntry({
      type: EVENT_COMMAND,
      agent: 'a',
      session,
      timestamp: Math.round(ts * 1000),
      command,
      exitCode: 0,
    }),
  )
}

function decode(b: Uint8Array | undefined): string {
  return b === undefined ? '' : new TextDecoder().decode(b)
}

describe('Observer', () => {
  it('logOp writes one JSONL line under the UTC-date folder', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store)
    const rec = new OpRecord({
      op: 'read',
      path: '/data/f.csv',
      source: 's3',
      bytes: 100,
      timestamp: 1000,
      durationMs: 5,
    })
    await o.logOp(rec, 'agent-1', 'sess-1')
    const parsed = JSON.parse(
      decode(store.files.get(`/${utcDateFolder()}/sess-1.jsonl`)).trim(),
    ) as Record<string, unknown>
    expect(parsed.type).toBe('op')
    expect(parsed.agent).toBe('agent-1')
    expect(parsed.session).toBe('sess-1')
    expect(parsed.op).toBe('read')
  })

  it('logExecution writes a command JSONL line', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store)
    const io = new IOResult({ stdout: new TextEncoder().encode('file.csv\n') })
    await o.logExecution('ls /data', io, [], 'agent-1', 'sess-1')
    const parsed = JSON.parse(
      decode(store.files.get(`/${utcDateFolder()}/sess-1.jsonl`)).trim(),
    ) as Record<string, unknown>
    expect(parsed.type).toBe('command')
    expect(parsed.session).toBe('sess-1')
    expect(parsed.command).toBe('ls /data')
    expect(parsed.stdout).toBe('file.csv\n')
    expect(parsed.exit_code).toBe(0)
  })

  it('appends successive entries', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store)
    for (let i = 0; i < 3; i++) {
      const rec = new OpRecord({
        op: 'read',
        path: `/f${String(i)}`,
        source: 's3',
        bytes: i,
        timestamp: 1000 + i,
        durationMs: 1,
      })
      await o.logOp(rec, 'a', 's')
    }
    const lines = decode(store.files.get(`/${utcDateFolder()}/s.jsonl`))
      .trim()
      .split('\n')
    expect(lines).toHaveLength(3)
  })

  it('defaults to a RAM store', () => {
    const o = new Observer()
    expect(o.store).toBeInstanceOf(RAMObserverStore)
  })

  it('logClear appends a tombstone', async () => {
    const o = new Observer()
    await o.logClear('s1', 'a1')
    const events = await o.events()
    const last = events[events.length - 1]
    expect(last?.type).toBe('clear')
    expect(last?.session).toBe('s1')
  })

  it('commandEvents spans all sessions in timestamp order', async () => {
    const o = new Observer()
    await logCommand(o, 'ls /a', 's2', 1.0)
    await logCommand(o, 'ls /b', 's1', 2.0)
    const op = new OpRecord({
      op: 'read',
      path: '/f',
      source: 'ram',
      bytes: 0,
      timestamp: 1500,
      durationMs: 1,
    })
    await o.logOp(op, 'a', 's1')
    const events = await o.commandEvents()
    expect(events.map((e) => e.command)).toEqual(['ls /a', 'ls /b'])
    expect(events.every((e) => e.type === 'command')).toBe(true)
  })

  it('filters exact session before applying history edits', async () => {
    const o = new Observer()
    await logCommand(o, 'own', 'alice', 1.0)
    await logCommand(o, 'foreign', 'team/alice', 2.0)
    await o.logDelete('team/alice', 1, 'a')
    await o.logClear('team/alice', 'a')
    await logCommand(o, 'foreign after clear', 'team/alice', 3.0)
    expect((await o.commandEvents('alice')).map((e) => e.command)).toEqual(['own'])
    expect((await o.sessionCommandEvents('alice')).map((e) => e.command)).toEqual(['own'])
    expect((await o.commandEvents('team/alice')).map((e) => e.command)).toEqual([
      'foreign',
      'foreign after clear',
    ])
    expect((await o.sessionCommandEvents('team/alice')).map((e) => e.command)).toEqual([
      'foreign after clear',
    ])
  })

  it('same-timestamp entries keep append order', async () => {
    const o = new Observer()
    await logCommand(o, 'first', 's1', 1.0)
    await logCommand(o, 'second', 's1', 1.0)
    await logCommand(o, 'third', 's1', 1.0)
    const events = await o.sessionCommandEvents('s1')
    expect(events.map((e) => e.command)).toEqual(['first', 'second', 'third'])
  })

  it('sessionCommandEvents respects the last clear', async () => {
    const o = new Observer()
    await logCommand(o, 'cmd A', 's1', 1.0)
    await o.logClear('s1', 'a')
    await logCommand(o, 'cmd B', 's1', 2.0)
    await logCommand(o, 'cmd C', 's2', 3.0)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['cmd B'])
    expect((await o.sessionCommandEvents('s2')).map((e) => e.command)).toEqual(['cmd C'])
  })

  it('loadEvents restores and resumes', async () => {
    const o = new Observer()
    await logCommand(o, 'old', 's1', 1.0)
    const events = await o.events()
    const restored = new Observer()
    await restored.loadEvents(events)
    await logCommand(restored, 'new', 's1', 2.0)
    expect((await restored.commandEvents()).map((e) => e.command)).toEqual(['old', 'new'])
  })

  it('logCommandText appends a single entry', async () => {
    const o = new Observer()
    await o.logCommandText('a b c', 's1')
    const events = await o.sessionCommandEvents('s1')
    expect(events.map((e) => e.command)).toEqual(['a b c'])
    expect(events[0]?.exit_code).toBe(0)
  })

  it('delete removes an entry and renumbers', async () => {
    const o = new Observer()
    await logCommand(o, 'one', 's1', 1.0)
    await logCommand(o, 'two', 's1', 2.0)
    await logCommand(o, 'three', 's1', 3.0)
    await o.logDelete('s1', 2)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['one', 'three'])
  })

  it('delete with a negative offset counts from the end', async () => {
    const o = new Observer()
    await logCommand(o, 'one', 's1', 1.0)
    await logCommand(o, 'two', 's1', 2.0)
    await o.logDelete('s1', -1)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['one'])
  })

  it('delete applies at its issue-time position', async () => {
    const o = new Observer()
    await logCommand(o, 'one', 's1', 1.0)
    await o.logDelete('s1', 1)
    await logCommand(o, 'two', 's1', 2.0)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['two'])
  })

  it('clear discards earlier deletes', async () => {
    const o = new Observer()
    await logCommand(o, 'one', 's1', 1.0)
    await o.logDelete('s1', 1)
    await o.logClear('s1')
    await logCommand(o, 'two', 's1', 2.0)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['two'])
  })

  it('loadEvents rewinds the pre-restore timeline', async () => {
    const src = new Observer()
    await logCommand(src, 'snap-cmd', 'snap', 2.0)
    const snapshotEvents = await src.events()
    const o = new Observer()
    await logCommand(o, 'old-live', 'live', 1.0)
    await o.loadEvents(snapshotEvents)
    expect((await o.commandEvents()).map((e) => e.command)).toEqual(['snap-cmd'])
    expect(new Set((await o.events()).map((e) => e.session))).toEqual(new Set(['snap']))
  })

  it('loadEvents with an empty snapshot still clears', async () => {
    const o = new Observer()
    await logCommand(o, 'old', 's1', 1.0)
    await o.loadEvents([])
    expect(await o.events()).toEqual([])
  })

  it('loadEvents skips foreign-format entries', async () => {
    const o = new Observer()
    const foreign = {
      agent: 'default',
      command: 'cat /a | wc -l',
      stdout: '5\n',
      tree: { command: 'cat /a | wc -l', children: [] },
      session_id: 'default',
    }
    const native = { type: EVENT_COMMAND, session: 's1', command: 'echo hi' }
    await o.loadEvents([foreign, native])
    expect((await o.commandEvents()).map((e) => e.command)).toEqual(['echo hi'])
  })
})
