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

import {
  trace,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IOResult } from '../io/types.ts'
import { ManualClock } from '../utils/clock.ts'
import { EVENT_COMMAND, LogEntry } from './log_entry.ts'
import { Observer, logger } from './observer.ts'
import { OpRecord } from './record.ts'
import { RAMObserverStore } from './store.ts'

const NEW_YEAR = 1_609_459_200

function logEntry(o: Observer, entry: LogEntry): Promise<void> {
  return (o as unknown as { log: (e: LogEntry) => Promise<void> }).log(entry)
}

function logCommand(o: Observer, command: string, session: string, ts: number): Promise<void> {
  return logEntry(
    o,
    new LogEntry({
      type: EVENT_COMMAND,
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
  afterEach(() => {
    trace.disable()
  })

  it('logOp writes one JSONL line under the UTC-date folder', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store, new ManualClock(NEW_YEAR))
    const rec = new OpRecord({
      op: 'read',
      path: '/data/f.csv',
      source: 's3',
      bytes: 100,
      timestamp: NEW_YEAR * 1000,
      durationMs: 5,
    })
    await o.logOp(rec, 'sess-1')
    const parsed = JSON.parse(decode(store.files.get('/2021-01-01/sess-1.jsonl')).trim()) as Record<
      string,
      unknown
    >
    expect(parsed.type).toBe('vfs')
    expect(parsed.session).toBe('sess-1')
    expect(parsed.vfs).toBe('read')
  })

  it('writes a line as its command, then its result', async () => {
    const store = new RAMObserverStore()
    const clock = new ManualClock(NEW_YEAR + 1.5)
    const o = new Observer(store, clock)
    await o.logCommand('ls /data', 'sess-1', undefined, 'L')
    clock.advance(2)
    const io = new IOResult({
      stdout: new TextEncoder().encode('file.csv\n'),
      stderr: new TextEncoder().encode('ls: warn\n'),
      exitCode: 1,
    })
    await o.logResult(io, [], 'sess-1', undefined, 'L')
    const [command, result] = decode(store.files.get('/2021-01-01/sess-1.jsonl'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(command).toEqual({
      type: 'command',
      session: 'sess-1',
      timestamp: 1_609_459_201_500,
      id: 'L',
      command: 'ls /data',
    })
    expect(result).toEqual({
      type: 'result',
      session: 'sess-1',
      timestamp: 1_609_459_203_500,
      parent: 'L',
      duration_ms: 2000,
      exit_code: 1,
      stdout: 'file.csv\n',
      stderr: 'ls: warn\n',
    })
  })

  it('lists a line once its result is in', async () => {
    const o = new Observer()
    await o.logCommand('sleep 1', 's1', undefined, 'L')
    expect(await o.sessionCommandEvents('s1')).toEqual([])
    expect(await o.commandEvents()).toEqual([])
    await o.logResult(new IOResult(), [], 's1', undefined, 'L')
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['sleep 1'])
    expect((await o.commandEvents()).map((e) => e.command)).toEqual(['sleep 1'])
  })

  // Twin of test_a_long_line_lets_the_loop_run_while_it_logs.
  it('lets the loop run while it logs a long line', async () => {
    const o = new Observer(new RAMObserverStore(), new ManualClock(NEW_YEAR))
    const rec = new OpRecord({
      op: 'read',
      path: '/f',
      source: 'ram',
      bytes: 1,
      timestamp: NEW_YEAR * 1000,
      durationMs: 1,
    })
    let turned = false
    setTimeout(() => {
      turned = true
    }, 0)
    await o.logResult(new IOResult(), new Array<OpRecord>(10_000).fill(rec), 's')
    expect(turned).toBe(true)
  })

  it('appends successive entries', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store, new ManualClock(NEW_YEAR))
    for (let i = 0; i < 3; i++) {
      const rec = new OpRecord({
        op: 'read',
        path: `/f${String(i)}`,
        source: 's3',
        bytes: i,
        timestamp: NEW_YEAR * 1000 + i,
        durationMs: 1,
      })
      await o.logOp(rec, 's')
    }
    const lines = decode(store.files.get('/2021-01-01/s.jsonl')).trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('defaults to a RAM store', () => {
    const o = new Observer()
    expect(o.store).toBeInstanceOf(RAMObserverStore)
  })

  it('logClear appends a tombstone', async () => {
    const o = new Observer()
    await o.logClear('s1')
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
    await o.logOp(op, 's1')
    const events = await o.commandEvents()
    expect(events.map((e) => e.command)).toEqual(['ls /a', 'ls /b'])
    expect(events.every((e) => e.type === 'command')).toBe(true)
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
    await o.logClear('s1')
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
    expect(events[0]).not.toHaveProperty('id')
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

describe('a clock behind stored history', () => {
  it('does not reorder a stored log', async () => {
    const store = new RAMObserverStore()
    const first = new Observer(store, new ManualClock(NEW_YEAR))
    await first.logCommandText('a', 's')
    await first.logCommandText('b', 's')
    const reopened = new Observer(store, new ManualClock())
    await reopened.logDelete('s', 1)
    expect((await reopened.sessionCommandEvents('s')).map((e) => e.command)).toEqual(['b'])
    await reopened.logClear('s')
    await reopened.logCommandText('c', 's')
    expect((await reopened.sessionCommandEvents('s')).map((e) => e.command)).toEqual(['c'])
    expect((await reopened.events()).map((e) => e.type)).toEqual([
      'command',
      'command',
      'delete',
      'clear',
      'command',
    ])
    expect([...store.files.keys()]).toEqual(['/2021-01-01/s.jsonl'])
  })

  it('does not reorder a restored log', async () => {
    const restored = new Observer(undefined, new ManualClock())
    await restored.loadEvents([
      { type: 'command', session: 's', timestamp: NEW_YEAR * 1000, command: 'a', exit_code: 0 },
    ])
    await restored.logClear('s')
    expect(await restored.sessionCommandEvents('s')).toEqual([])
  })

  it('reads only the entry session for the floor', async () => {
    class NoScanStore extends RAMObserverStore {
      override readAll(): Promise<Map<string, Uint8Array>> {
        return Promise.reject(new Error("read every session's history"))
      }
    }
    const store = new NoScanStore()
    const first = new Observer(store, new ManualClock(NEW_YEAR))
    await first.logCommandText('a', 's')
    await first.logCommandText('x', 't')
    const reopened = new Observer(store, new ManualClock())
    await reopened.logClear('s')
    expect(await reopened.sessionCommandEvents('s')).toEqual([])
    expect((await reopened.sessionCommandEvents('t')).map((e) => e.command)).toEqual(['x'])
  })

  it('sets no floor for an empty history', async () => {
    const o = new Observer(undefined, new ManualClock(-1))
    await o.logCommandText('a', 's')
    expect((await o.events()).map((e) => e.timestamp)).toEqual([-1000])
  })
})

describe('a damaged history file', () => {
  it('costs only the torn line and the entry appended onto it', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store, new ManualClock(NEW_YEAR))
    await logCommand(o, 'first', 's1', NEW_YEAR)
    const [path = ''] = [...store.files.keys()]
    const torn = new TextEncoder().encode(
      '{"type": "command", "session": "s1", "command": "caf\u00e9',
    )
    await store.append(path, torn.slice(0, -1))
    await logCommand(o, 'second', 's1', NEW_YEAR + 1)
    await logCommand(o, 'third', 's1', NEW_YEAR + 2)
    const printed = vi.spyOn(console, 'debug')
    const debug = vi.fn()
    try {
      const shown = await o.sessionCommandEvents('s1')
      expect(shown.map((e) => e.command)).toEqual(['first', 'third'])
      logger.debug = debug
      const every = await o.commandEvents()
      expect(every.map((e) => e.command)).toEqual(['first', 'third'])
      expect(printed).not.toHaveBeenCalled()
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining(`skipping unparseable history line in ${path}`),
      )
    } finally {
      delete logger.debug
      printed.mockRestore()
    }
  })

  it('keeps an entry whose command holds a line separator', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store, new ManualClock(NEW_YEAR))
    await logCommand(o, 'first', 's1', NEW_YEAR)
    const [path = ''] = [...store.files.keys()]
    const raw =
      '{"type": "command", "session": "s1", "timestamp": 1609459201000, "command": "a\u2028b\u0085c"}\n'
    await store.append(path, new TextEncoder().encode(raw))
    const shown = await o.sessionCommandEvents('s1')
    expect(shown.map((e) => e.command)).toEqual(['first', 'a\u2028b\u0085c'])
  })

  it('names one flat log for each session id', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store, new ManualClock(NEW_YEAR))
    for (const session of ['s1', 'team/s1', '../x']) {
      await o.logCommandText(`echo ${session}`, session)
    }
    expect([...store.files.keys()].sort()).toEqual([
      '/2021-01-01/..%2Fx.jsonl',
      '/2021-01-01/s1.jsonl',
      '/2021-01-01/team%2Fs1.jsonl',
    ])
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['echo s1'])
  })

  it('files a long session id under a bounded name', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store, new ManualClock(NEW_YEAR))
    const [long, longer] = ['\u00e9'.repeat(50), '\u00e9'.repeat(51)]
    for (const session of [long, longer]) {
      await o.logCommandText(`echo ${String(session.length)}`, session)
    }
    const names = [...store.files.keys()].map((key) => key.split('/').at(-1) ?? '')
    expect(names).toHaveLength(2)
    expect(names.every((name) => new TextEncoder().encode(name).length <= 255)).toBe(true)
    expect((await o.sessionCommandEvents(long)).map((e) => e.command)).toEqual(['echo 50'])
  })

  it('sends a finished line as a span over its vfs calls', async () => {
    const spans: { name: string; options: SpanOptions; parent: Span | undefined; end?: unknown }[] =
      []
    const fake: Tracer = {
      startSpan(name, options = {}, ctx) {
        const seen: (typeof spans)[number] = {
          name,
          options,
          parent: ctx === undefined ? undefined : trace.getSpan(ctx),
        }
        spans.push(seen)
        return {
          isRecording: () => true,
          end: (time?: unknown) => {
            seen.end = time
          },
          spanContext: () => ({
            traceId: '1'.repeat(32),
            spanId: String(spans.length).repeat(16),
            traceFlags: 1,
          }),
        } as unknown as Span
      },
      startActiveSpan: () => {
        throw new Error('unused')
      },
    }
    const provider: TracerProvider = { getTracer: () => fake }
    trace.setGlobalTracerProvider(provider)
    const clock = new ManualClock(NEW_YEAR)
    const o = new Observer(new RAMObserverStore(), clock, 'w')
    const start = NEW_YEAR * 1000
    const rec = new OpRecord({
      op: 'read',
      path: '/d/a',
      source: 's3',
      bytes: 6,
      timestamp: start + 5,
      durationMs: 12,
    })
    await o.logCommand('cat /d/a', 's1', undefined, 'L')
    clock.advance(1)
    await o.logResult(new IOResult({ exitCode: 1 }), [rec], 's1', undefined, 'L')
    const [line, call] = spans
    expect([line?.name, line?.options.attributes, line?.options.startTime, line?.end]).toEqual([
      'command',
      {
        'mirage.session.id': 's1',
        'mirage.command': 'cat /d/a',
        'mirage.exit_code': 1,
        'mirage.workspace.id': 'w',
      },
      start,
      start + 1000,
    ])
    expect([call?.name, call?.options.attributes, call?.options.startTime, call?.end]).toEqual([
      'vfs.read',
      { 'mirage.vfs.path': '/d/a', 'mirage.vfs.source': 's3', 'mirage.vfs.bytes': 6 },
      start - 7,
      start + 5,
    ])
    expect(call?.parent).toBeDefined()
  })

  it('lists lines in the order they ended, each ended once', async () => {
    const clock = new ManualClock(NEW_YEAR)
    const o = new Observer(new RAMObserverStore(), clock)
    await o.logCommand('sleep 9', 's1', undefined, 'slow')
    clock.advance(1)
    await o.logCommand('echo quick', 's2', undefined, 'quick')
    clock.advance(1)
    await o.logResult(new IOResult(), [], 's2', undefined, 'quick')
    clock.advance(1)
    await o.logResult(new IOResult(), [], 's1', undefined, 'slow')
    await o.logResult(new IOResult(), [], 's1', undefined, 'slow')
    expect((await o.commandEvents()).map((e) => e.command)).toEqual(['echo quick', 'sleep 9'])
    const results = (await o.events()).filter((e) => e.type === 'result')
    expect(results.map((e) => [e.parent, e.duration_ms])).toEqual([
      ['quick', 1000],
      ['slow', 3000],
    ])
  })
})
