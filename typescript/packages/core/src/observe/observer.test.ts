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
  type Attributes,
  type Context,
  type Link,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IOResult } from '../io/types.ts'
import { CHECK_MARK, RUN_PID_MARK, isRun } from '../machine/constants.ts'
import { MachineHandle } from '../machine/handle.ts'
import { RemoteRuntime } from '../runtime/machine/runtime.ts'
import type { RunResult } from '../runtime/types.ts'
import type { Policy } from '../policy/base.ts'
import { MountMode, PathSpec } from '../types.ts'
import type { Process } from '../execution/process/types.ts'
import { LineId, MachineName, ProcessId } from '../execution/types.ts'
import { ManualClock } from '../utils/clock.ts'
import { EVENT_COMMAND, LogEntry } from './log_entry.ts'
import {
  TRACE_CONTENT_ENV,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_CONTENT_MAX_BYTES_ENV,
} from './constants.ts'
import { Observer, logger } from './observer.ts'
import { OpRecord } from './record.ts'
import { RAMObserverStore } from './store.ts'
import { RouteError } from '../runtime/routing/index.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'

const NEW_YEAR = 1_609_459_200

/** Take every span the observer starts, its name and attributes. Mirrors Python's `_exported`. */
interface Seen {
  name: string
  attributes: Attributes
  startTime: unknown
  end?: unknown
  parent: SpanContext | undefined
  context: SpanContext
  links: Link[]
}

/**
 * Record each span the observer starts: its attributes, those it sets
 * later included, its start and end, its own context and the span it is
 * under.
 */
function exported(): Seen[] {
  const spans: Seen[] = []
  const fake = {
    startSpan(name: string, options: SpanOptions = {}, ctx?: Context) {
      const seen: Seen = {
        name,
        attributes: { ...(options.attributes ?? {}) },
        startTime: options.startTime,
        parent: ctx === undefined ? undefined : trace.getSpanContext(ctx),
        context: {
          traceId: '1'.repeat(32),
          spanId: String(spans.length + 1).padStart(16, '0'),
          traceFlags: 1,
        },
        links: [],
      }
      spans.push(seen)
      const span = {
        isRecording: () => true,
        setAttribute: (key: string, value: Attributes[string]) => {
          seen.attributes[key] = value
          return span
        },
        end: (time?: unknown) => {
          seen.end = time
        },
        addLink: (link: Link) => {
          seen.links.push(link)
          return span
        },
        spanContext: () => seen.context,
      }
      return span as unknown as Span
    },
  } as unknown as Tracer
  trace.setGlobalTracerProvider({ getTracer: () => fake })
  return spans
}

/** A postExecute policy that lets every line's output through. */
class SeesOutput implements Policy {
  postExecute(): null {
    return null
  }
}

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

/** A span's kind and the command it stands for. Mirrors Python's `_span_name`. */
function spanName(s: Seen): string {
  return `${s.name} ${String(s.attributes['process.command_line'] ?? s.attributes['mirage.command'])}`
}

/** The machine a span names: its type, name and provider id. */
function spanMachine(span: Seen | undefined): unknown[] {
  return [
    span?.attributes['mirage.machine.type'],
    span?.attributes['mirage.machine.name'],
    span?.attributes['mirage.machine.id'],
  ]
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
    await o.logDelete('s1', await o.sessionCommandEvents('s1'), 1)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['one', 'three'])
  })

  it('a delete keeps its entry when older lines go', async () => {
    const store = new RAMObserverStore()
    const o = new Observer(store)
    await logCommand(o, 'one', 's1', 1.0)
    await logCommand(o, 'two', 's1', 2.0)
    await logCommand(o, 'three', 's1', 3.0)
    await o.logDelete('s1', await o.sessionCommandEvents('s1'), 1)
    for (const [path, data] of store.files) {
      store.files.set(path, data.subarray(data.indexOf(0x0a) + 1))
      break
    }
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['three'])
  })

  it('a delete takes the copy it names', async () => {
    const o = new Observer()
    await logCommand(o, 'a', 's1', 1.0)
    await logCommand(o, 'b', 's1', 1.0)
    await logCommand(o, 'a', 's1', 1.0)
    await o.logDelete('s1', await o.sessionCommandEvents('s1'), 2)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['a', 'b'])
  })

  it('delete applies at its issue-time position', async () => {
    const o = new Observer()
    await logCommand(o, 'one', 's1', 1.0)
    await o.logDelete('s1', await o.sessionCommandEvents('s1'), 0)
    await logCommand(o, 'two', 's1', 2.0)
    expect((await o.sessionCommandEvents('s1')).map((e) => e.command)).toEqual(['two'])
  })

  it('clear discards earlier deletes', async () => {
    const o = new Observer()
    await logCommand(o, 'one', 's1', 1.0)
    await o.logDelete('s1', await o.sessionCommandEvents('s1'), 0)
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
    await reopened.logDelete('s', await reopened.sessionCommandEvents('s'), 0)
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
  // A tracer provider registers once until it is disabled.
  afterEach(() => {
    trace.disable()
    vi.unstubAllEnvs()
  })

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

  it('sends a finished line as one span its vfs calls stay out of', async () => {
    const spans = exported()
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
    await o.logCommand('cat /d/a', 's1', '/d', 'L')
    clock.advance(1)
    const io = new IOResult({
      stdout: new TextEncoder().encode('x'.repeat(20000)),
      stderr: new TextEncoder().encode('cat: /d/b: No such file\n'),
      exitCode: 1,
    })
    // The line ends in another cwd; the span keeps the one it started in.
    await o.logResult(io, [rec], 's1', '/', 'L')
    expect(spans).toHaveLength(1)
    const [line] = spans
    expect([line?.name, line?.attributes, line?.startTime, line?.end]).toEqual([
      'command',
      {
        'mirage.line.id': 'L',
        'mirage.session.id': 's1',
        'mirage.command': 'cat /d/a',
        'mirage.exit_code': 1,
        'mirage.timestamp': start,
        'mirage.duration_ms': 1000,
        'mirage.stdout': 'x'.repeat(TRACE_CONTENT_MAX_BYTES),
        'mirage.stderr': 'cat: /d/b: No such file\n',
        'mirage.workspace.id': 'w',
        'mirage.cwd': '/d',
      },
      start,
      start + 1000,
    ])
    // The history keeps the call, and its own, shorter cut.
    const events = await o.events()
    expect(events.filter((e) => e.type === 'vfs').map((e) => e.path)).toEqual(['/d/a'])
    const results = events.filter((e) => e.type === 'result')
    expect(results.map((e) => String(e.stdout).length)).toEqual([4096])
  })

  it('cuts span output at the bytes it is told to', async () => {
    vi.stubEnv(TRACE_CONTENT_MAX_BYTES_ENV, '5')
    const spans = exported()
    const o = new Observer(new RAMObserverStore(), new ManualClock(NEW_YEAR))
    await o.logCommand('echo', 's1', '/', 'L')
    // Two bytes a character: five bytes end inside the third, which is
    // left out rather than shown as U+FFFD.
    const io = new IOResult({ stdout: new TextEncoder().encode('ééé') })
    await o.logResult(io, [], 's1', '/', 'L')
    expect(spans[0]?.attributes['mirage.stdout']).toBe('éé')
  })

  it('keeps span output that is not UTF-8 within its bytes', async () => {
    const spans = exported()
    const o = new Observer(new RAMObserverStore(), new ManualClock(NEW_YEAR))
    await o.logCommand('cat blob', 's1', '/', 'L')
    // Each byte reads as U+FFFD, three bytes in UTF-8.
    const io = new IOResult({ stdout: new Uint8Array(TRACE_CONTENT_MAX_BYTES).fill(0xff) })
    await o.logResult(io, [], 's1', '/', 'L')
    expect(spans[0]?.attributes['mirage.stdout']).toBe(
      '\ufffd'.repeat(Math.floor(TRACE_CONTENT_MAX_BYTES / 3)),
    )
  })

  it('keeps the cwd a line was given on its span', async () => {
    const spans = exported()
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    let history: Awaited<ReturnType<Workspace['history']>>
    try {
      // A postExecute policy has the line recorded whole, as one entry.
      ws.policies.add(new SeesOutput())
      await ws.shell('pwd', { cwd: '/data' })
      history = await ws.history()
    } finally {
      await ws.close()
    }
    const lines = spans.filter((s) => s.name === 'command')
    expect(lines.map((s) => s.attributes['mirage.cwd'])).toEqual(['/data'])
    expect(history.map((e) => e.cwd)).toEqual(['/data', '/data'])
  })

  it('takes output past the terminal chunk into its span', async () => {
    vi.stubEnv(TRACE_CONTENT_MAX_BYTES_ENV, '20000')
    const spans = exported()
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    let history: Awaited<ReturnType<Workspace['history']>>
    try {
      await ws.shell('seq 1 10000')
      history = await ws.history()
    } finally {
      await ws.close()
    }
    const lines = spans.filter((s) => s.name === 'command')
    expect(lines.map((s) => String(s.attributes['mirage.stdout']).length)).toEqual([20000])
    // The history keeps its own cut.
    const results = history.filter((e) => e.type === 'result')
    expect(results.map((e) => String(e.stdout).length)).toEqual([4096])
  })

  it('keeps output out of spans when told to', async () => {
    vi.stubEnv(TRACE_CONTENT_ENV, 'false')
    const spans = exported()
    const o = new Observer(new RAMObserverStore(), new ManualClock(NEW_YEAR), 'w')
    const rec = new OpRecord({
      op: 'read',
      path: '/d/a',
      source: 's3',
      bytes: 6,
      timestamp: NEW_YEAR * 1000,
      durationMs: 1,
    })
    await o.logCommand('cat /d/a', 's1', '/d', 'L')
    const io = new IOResult({ stdout: new TextEncoder().encode('secret\n') })
    await o.logResult(io, [rec], 's1', '/d', 'L')
    expect(spans.map((s) => [s.name, s.attributes])).toEqual([
      [
        'command',
        {
          'mirage.line.id': 'L',
          'mirage.session.id': 's1',
          'mirage.command': 'cat /d/a',
          'mirage.exit_code': 0,
          'mirage.timestamp': NEW_YEAR * 1000,
          'mirage.duration_ms': 0,
          'mirage.workspace.id': 'w',
          'mirage.cwd': '/d',
        },
      ],
    ])
    // The history itself still keeps the output.
    const results = (await o.events()).filter((e) => e.type === 'result')
    expect(results.map((e) => e.stdout)).toEqual(['secret\n'])
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

// A line whose route is refused still ends its span, as its history ends
// its entry.
it('ends the span of a line whose route is refused', async () => {
  const spans = exported()
  const ws = new Workspace({ '/data': new RAMVFS() })
  try {
    await expect(ws.shell('echo hi', { runtime: 'nope' })).rejects.toBeInstanceOf(RouteError)
    const [command] = spans.filter((s) => s.name === 'command')
    expect(command?.end).toBeDefined()
    expect(command?.attributes['mirage.exit_code']).not.toBe(0)
  } finally {
    await ws.close()
    trace.disable()
  }
})

// A job and each process a line ran are spans of their own once they end,
// named by their line, session, workspace, machine and cwd: the line's own
// process under the line's span, the job under it and the job's process
// under the job.
it('sends an ended job and process as spans', async () => {
  const spans = exported()
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.shell('sleep 30 & kill %1; wait')
    const [line] = await ws.lines()
    const [job] = spans.filter((s) => s.name === 'job')
    expect([
      job?.attributes['mirage.job.number'],
      job?.attributes['mirage.command'],
      job?.attributes['mirage.line.id'],
    ]).toEqual([1, 'sleep 30', line?.id.value])
    const [sleep] = spans.filter(
      (s) => s.name === 'process' && s.attributes['process.command_line'] === 'sleep 30',
    )
    expect(sleep?.attributes['process.exit.code']).toBe(143)
    expect(sleep?.attributes['mirage.signal']).toBe(15)
    expect(sleep?.attributes['mirage.line.id']).toBe(line?.id.value)
    expect(sleep?.attributes['mirage.session.id']).toBe(line?.sessionId)
    expect(sleep?.attributes['mirage.cwd']).toBe('/')
    const machine = ws.processTable.machine
    expect(sleep?.attributes['host.name']).toBe(machine.name)
    expect(spanMachine(sleep)).toEqual(['host', machine.name, machine.name])
    const [command] = spans.filter((s) => s.name === 'command')
    expect(command?.attributes['mirage.line.id']).toBe(line?.id.value)
    expect(command?.attributes['host.name']).toBe(machine.name)
    expect(command?.attributes['mirage.machine.ids']).toBeUndefined()
    const [shell] = spans.filter(
      (s) =>
        s.name === 'process' && s.attributes['process.command_line'] === 'sleep 30 & kill %1; wait',
    )
    expect(shell?.parent).toEqual(command?.context)
    expect(job?.parent).toEqual(shell?.context)
    expect(sleep?.parent).toEqual(job?.context)
    expect(job?.attributes['process.pid']).toBe(sleep?.attributes['process.pid'])
    expect(job?.attributes['host.name']).toBe(machine.name)
    expect(spanMachine(job)).toEqual(['host', machine.name, machine.name])
    expect(job?.attributes['mirage.cwd']).toBe('/')
  } finally {
    await ws.close()
    trace.disable()
  }
})

const ENC = new TextEncoder()

class Box extends MachineHandle {
  static override readonly provider = 'box'

  override get instance(): string {
    return `box-${this.name}`
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override async execArgv(
    argv: readonly string[],
    _stdin: unknown,
    _env: unknown,
    _cwd: string,
    _output: unknown,
    errors: ((data: Uint8Array) => Promise<void>) | null,
  ): Promise<RunResult> {
    if (isRun(argv)) await errors?.(new Uint8Array([...RUN_PID_MARK, ...ENC.encode('812 99\n')]))
    return { stdout: ENC.encode(`${CHECK_MARK}\n`), stderr: null, exitCode: 0 }
  }
}

// Each job and process span names where its work ran, by the machine's
// provider, its name and what its provider calls it, and `host.name` the host
// running Mirage.
it("names the machine a span's work ran on", async () => {
  const spans = exported()
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: { a: new Box('a') },
      runtimes: [new RemoteRuntime({ captures: ['train'], machine: 'a' })],
    },
  )
  try {
    await ws.shell('train 1 & wait')
    await ws.shell('echo hi')
    await ws.shell('echo a\ntrain 2')
    const name = ws.processTable.machine.name
    expect(
      spans.filter((s) => s.name === 'command').map((s) => s.attributes['mirage.machine.ids']),
    ).toEqual([undefined, undefined, undefined, undefined])
    const ran = spans
      .filter((s) => s.name === 'job' || s.name === 'process')
      .map((s) => [
        s.name,
        s.attributes['process.command_line'] ?? s.attributes['mirage.command'],
        s.attributes['mirage.machine.type'],
        s.attributes['mirage.machine.name'],
        s.attributes['mirage.machine.id'],
        s.attributes['host.name'],
      ])
      .sort()
    const pids = new Map(
      spans
        .filter((s) => s.name === 'process')
        .map((s) => [
          s.attributes['process.command_line'],
          [s.attributes['process.pid'], s.attributes['mirage.process.pid']],
        ]),
    )
    expect(pids.get('train 2')?.[0]).toBe(812)
    expect(pids.get('train 2')?.[1]).not.toBe(812)
    expect(pids.get('echo hi')?.[0]).toBe(pids.get('echo hi')?.[1])
    expect(ran).toEqual([
      ['job', 'train 1', 'box', 'a', 'box-a', name],
      ['process', 'echo a\ntrain 2', 'host', name, name, name],
      ['process', 'echo hi', 'host', name, name, name],
      ['process', 'train 1 & wait', 'host', name, name, name],
      ['process', 'train 1', 'box', 'a', 'box-a', name],
      ['process', 'train 2', 'box', 'a', 'box-a', name],
    ])
  } finally {
    await ws.close()
    trace.disable()
  }
})

// A line nobody traces leaves the process records unread.
it('reads no process records for a line nobody traces', async () => {
  trace.disable()
  let reads = 0
  const obs = new Observer(undefined, undefined, undefined, undefined, () => {
    reads += 1
    return []
  })
  await obs.logCommand('true', 's', undefined, 'line_1')
  await obs.logResult(new IOResult({ exitCode: 0 }), [], 's', undefined, 'line_1')
  expect(reads).toBe(0)
})

// A process started under a parent that is stopping, as a killed job's
// child still finishing, still goes under that parent's span.
it('puts a child of a stopping parent under it', async () => {
  const spans = exported()
  const base = {
    sessionId: 's',
    line: new LineId('line_1'),
    group: 10,
    cwd: PathSpec.fromStrPath('/'),
    machinePid: null,
    signal: null,
    error: null,
    ancestors: [],
  }
  const shell: Process = {
    ...base,
    id: new ProcessId('w', 10),
    parent: null,
    command: '(train) &',
    machine: new MachineName('host', 'h'),
    startedAt: 1,
    runtime: null,
    state: 'stopping',
    endedAt: null,
    exit: null,
  }
  const child: Process = {
    ...base,
    id: new ProcessId('w', 11),
    parent: 10,
    command: 'train',
    machine: new MachineName('box', 'a'),
    startedAt: 2,
    runtime: 'remote',
    state: 'exited',
    endedAt: 3,
    exit: 143,
  }
  try {
    const obs = new Observer(undefined, undefined, undefined, undefined, () => [shell, child])
    await obs.logCommand('(train) &', 's', undefined, 'line_1')
    obs.traceProcess(child)
    obs.traceProcess({ ...shell, state: 'exited', endedAt: 4, exit: 143 })
    await obs.logResult(new IOResult({ exitCode: 143 }), [], 's', undefined, 'line_1')
    const named = new Map(
      spans.map((s) => [(s.attributes['process.command_line'] as string | undefined) ?? s.name, s]),
    )
    expect(named.get('train')?.parent).toEqual(named.get('(train) &')?.context)
    expect(named.get('(train) &')?.parent).toEqual(named.get('command')?.context)
  } finally {
    trace.disable()
  }
})

// A job started inside a background subshell lives in that subshell's job
// list; its process still goes under its job, and the job under the
// subshell.
it("puts a nested job's process under its job", async () => {
  const spans = exported()
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: { a: new Box('a') },
      runtimes: [new RemoteRuntime({ captures: ['train'], machine: 'a' })],
    },
  )
  try {
    await ws.shell('(train 1 & wait) & wait')
  } finally {
    await ws.close()
    trace.disable()
  }
  const byId = new Map(spans.map((s) => [s.context.spanId, s]))
  let span = spans.find((s) => spanName(s) === 'process train 1')
  const chain: string[] = []
  while (span?.parent !== undefined && byId.has(span.parent.spanId)) {
    span = byId.get(span.parent.spanId)
    if (span !== undefined) chain.push(spanName(span))
  }
  expect(chain).toEqual([
    'job train 1',
    'process (train 1 & wait)',
    'job (train 1 & wait)',
    'process (train 1 & wait) & wait',
    'command (train 1 & wait) & wait',
  ])
})

// A process links to each it read from, `mirage.input` naming where: its
// stdin, the `/dev/fd` path a `<( )` gave it, or its arguments.
it('links a process to each it read from', async () => {
  const spans = exported()
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      machines: { a: new Box('a') },
      runtimes: [new RemoteRuntime({ captures: ['train'], machine: 'a' })],
    },
  )
  try {
    await ws.shell('train 1 | train 2')
    await ws.shell('train 3 <(train 4); true')
    await ws.shell('train 5 "$(train 6)"; true')
  } finally {
    await ws.close()
    trace.disable()
  }
  const byId = new Map(spans.map((s) => [s.context.spanId, s]))
  const links = spans
    .flatMap((s) =>
      s.links.map((link) => [
        spanName(s),
        link.attributes?.['mirage.input'],
        spanName(byId.get(link.context.spanId) ?? s),
      ]),
    )
    .sort()
  expect(links).toEqual([
    ['process train 2', 'stdin', 'process train 1'],
    ['process train 3 /dev/fd/63', '/dev/fd/63', 'process train 4'],
    [`process train 5 ${CHECK_MARK}`, 'argv', 'process train 6'],
  ])
})
