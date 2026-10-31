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

import { context, trace, type Attributes, type Tracer } from '@opentelemetry/api'
import type { IOResult } from '../io/types.ts'
import { YieldBudget } from '../io/yield_budget.ts'
import { utcDateFolder } from '../utils/dates.ts'
import { SystemClock, type Clock } from '../utils/clock.ts'
import {
  EVENT_CLEAR,
  EVENT_COMMAND,
  EVENT_DELETE,
  EVENT_RESULT,
  EVENT_VFS,
  LogEntry,
  type LogEntryInit,
  STDOUT_TRUNCATE,
} from './log_entry.ts'
import type { OpRecord } from './record.ts'
import { type ObserverStore, RAMObserverStore } from './store.ts'
import { sha256Hex } from '../utils/hash.ts'
import { compareCodePoints } from '../utils/sort.ts'

/**
 * Opt in by assigning a debug sink, as Python's module logger is off until
 * configured: history is read after every command, and a torn line stays in
 * the file, so a sink that always wrote would repeat it on every read.
 */
export const logger: { debug?: (message: string) => void } = {}

const KNOWN_EVENTS = new Set<string>([
  EVENT_COMMAND,
  EVENT_CLEAR,
  EVENT_DELETE,
  EVENT_RESULT,
  EVENT_VFS,
])

export type EventDict = Record<string, unknown>

const NAME_LIMIT = 200

const TRACER_NAME = 'mirage.observe'

/**
 * The tracer a finished line goes to: a no-op until the process sets up
 * an OpenTelemetry SDK, whose exporter picks the backend.
 */
function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME)
}

/**
 * Send a finished line to OpenTelemetry: a `command` span over its run
 * (`span`, its start and end in epoch milliseconds), and under it a
 * `vfs.<call>` span for each call it made to a mount. Mirrors Python's
 * `_trace_line`.
 */
function traceLine(
  workspaceId: string | undefined,
  session: string,
  command: string,
  span: [number, number],
  exitCode: number,
  records: readonly OpRecord[],
): void {
  const attributes: Attributes = {
    'mirage.session.id': session,
    'mirage.command': command,
    'mirage.exit_code': exitCode,
  }
  if (workspaceId !== undefined) attributes['mirage.workspace.id'] = workspaceId
  const line = tracer().startSpan('command', { startTime: span[0], attributes })
  if (line.isRecording()) {
    const parent = trace.setSpan(context.active(), line)
    for (const rec of records) {
      const call = tracer().startSpan(
        `vfs.${rec.op}`,
        {
          startTime: rec.timestamp - rec.durationMs,
          attributes: {
            'mirage.vfs.path': rec.path,
            'mirage.vfs.source': rec.source,
            'mirage.vfs.bytes': rec.bytes,
          },
        },
        parent,
      )
      call.end(rec.timestamp)
    }
  }
  line.end(span[1])
}

/**
 * The name a session's log goes under in each day: its id percent-quoted
 * as Python's `quote(safe="")` does, so no id spans folders or ends like
 * another's. One that quotes past `NAME_LIMIT` keeps its start and ends
 * in a hash of the whole id, a character longer than the limit, so the
 * name fits a filesystem and meets no shorter one. Mirrors Python's
 * `_session_file`.
 */
async function sessionFile(session: string): Promise<string> {
  let quoted = encodeURIComponent(session).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  if (quoted.length > NAME_LIMIT) {
    const digest = await sha256Hex(new TextEncoder().encode(session))
    quoted = `${quoted.slice(0, NAME_LIMIT - digest.length)}~${digest}`
  }
  return `${quoted}.jsonl`
}

function parseFiles(files: Map<string, Uint8Array>): EventDict[] {
  const out: EventDict[] = []
  const decoder = new TextDecoder('utf-8', { fatal: false })
  for (const key of [...files.keys()].sort(compareCodePoints)) {
    if (!key.endsWith('.jsonl')) continue
    const text = decoder.decode(files.get(key))
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as EventDict)
      } catch (err) {
        // A crash mid-append tears a line and the entry appended onto it.
        if (!(err instanceof SyntaxError)) throw err
        logger.debug?.(`skipping unparseable history line in ${key}: ${String(err)}`)
      }
    }
  }
  return out
}

function eventTimestamp(e: EventDict): number {
  return typeof e.timestamp === 'number' ? e.timestamp : 0
}

/** The latest timestamp among `events`, null when none carries one. */
function newestStamp(events: readonly EventDict[]): number | null {
  return events.reduce<number | null>(
    (newest, e) =>
      typeof e.timestamp === 'number' ? later(newest, Math.floor(e.timestamp)) : newest,
    null,
  )
}

/** The later of two stamps, either of which may be absent. */
function later(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b)
}

/**
 * Persists LogEntry records to an ObserverStore as JSONL files.
 *
 * The hidden recorder: it owns no mount and its store is reachable only
 * through this class, so the log is invisible to agents. Views
 * (/.bash_history, the history builtin) render from the query methods
 * below; swapping infra (RAM, disk, opfs) means passing a different
 * store, nothing above this seam changes.
 *
 * Every entry is stamped, and filed under its day, on `clock`: the
 * workspace's, which also stamps the op records the entries carry, so a
 * workspace on a manual clock keeps one time domain in its history. No
 * entry is stamped before the newest one its session holds: a clock that
 * restarts behind stored history (a fresh `ManualClock` over a restored or
 * persisted log) would otherwise file a clear or delete ahead of the
 * commands it acts on. A session with no history sets no floor.
 *
 * Each line that ends also goes to OpenTelemetry as a span, its vfs calls
 * as spans under it; nothing leaves the process until an SDK is set up.
 */
export class Observer {
  private readonly _store: ObserverStore
  private readonly clock: Clock
  private readonly newest = new Map<string, number | null>()
  private readonly started = new Map<string, [number, number, string]>()

  constructor(
    store?: ObserverStore,
    clock: Clock = new SystemClock(),
    private readonly workspaceId?: string,
  ) {
    this._store = store ?? new RAMObserverStore()
    this.clock = clock
  }

  /** The clock's wall time in epoch milliseconds, an entry's stamp. */
  private nowMs(): number {
    return Math.floor(this.clock.now() * 1000)
  }

  get store(): ObserverStore {
    return this._store
  }

  /**
   * The newest stamp `session` holds, null when it holds none. Read once per
   * session, from that session's files only (the files its history view
   * reads); an entry stamped while they are read is newer still and is kept.
   */
  private async floor(session: string): Promise<number | null> {
    const known = this.newest.get(session)
    if (known !== undefined) return known
    const found = newestStamp(
      parseFiles(await this._store.readMatching(`/${await sessionFile(session)}`)),
    )
    const floor = later(found, this.newest.get(session) ?? null)
    this.newest.set(session, floor)
    return floor
  }

  private async log(entry: LogEntry): Promise<void> {
    const floor = await this.floor(entry.session)
    const stamped =
      floor !== null && entry.timestamp < floor
        ? Object.assign(Object.create(LogEntry.prototype) as LogEntry, entry, { timestamp: floor })
        : entry
    this.newest.set(stamped.session, stamped.timestamp)
    const line = new TextEncoder().encode(stamped.toJsonLine() + '\n')
    await this._store.append(
      `/${utcDateFolder(stamped.timestamp)}/${await sessionFile(stamped.session)}`,
      line,
    )
  }

  async logOp(rec: OpRecord, session: string, cwd?: string, parent?: string): Promise<void> {
    await this.log(LogEntry.fromOpRecord(rec, session, cwd, parent))
  }

  /**
   * Record a typed line as it starts, under its id `line`, which its vfs
   * calls and its result name as their parent.
   */
  async logCommand(command: string, session: string, cwd?: string, line?: string): Promise<void> {
    const init: LogEntryInit = { type: EVENT_COMMAND, session, timestamp: this.nowMs(), command }
    if (cwd !== undefined) init.cwd = cwd
    if (line !== undefined) init.id = line
    const began = this.clock.monotonic()
    await this.log(new LogEntry(init))
    if (line !== undefined) this.started.set(line, [init.timestamp, began, command])
  }

  /**
   * Record how a typed line ended: its vfs calls, then its result, each
   * naming the line as its parent. A line ends once: a second call for a
   * line already ended records nothing.
   */
  async logResult(
    io: IOResult,
    opRecords: OpRecord[],
    session: string,
    cwd?: string,
    line?: string,
  ): Promise<void> {
    // TODO: batch the vfs lines and the result line into a single
    // store.append so one typed line costs one roundtrip and lands
    // atomically in the store. A store whose append never suspends still
    // lets the loop run between a long line's records.
    const started = line === undefined ? undefined : this.started.get(line)
    if (line !== undefined) {
      if (started === undefined) return
      this.started.delete(line)
    }
    const budget = new YieldBudget()
    for (const rec of opRecords) {
      const pending = budget.run()
      if (pending !== undefined) await pending
      await this.logOp(rec, session, cwd, line)
    }
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const stdout = decoder.decode(await io.materializeStdout()).slice(0, STDOUT_TRUNCATE)
    const stderr = decoder.decode(await io.materializeStderr()).slice(0, STDOUT_TRUNCATE)
    const now = this.nowMs()
    const took =
      started === undefined ? undefined : Math.round((this.clock.monotonic() - started[1]) * 1000)
    if (started !== undefined && took !== undefined) {
      traceLine(
        this.workspaceId,
        session,
        started[2],
        [started[0], started[0] + took],
        io.exitCode,
        opRecords,
      )
    }
    const init: LogEntryInit = {
      type: EVENT_RESULT,
      session,
      timestamp: now,
      exitCode: io.exitCode,
      stdout,
      stderr,
    }
    if (cwd !== undefined) init.cwd = cwd
    if (line !== undefined) init.parent = line
    if (took !== undefined) init.durationMs = took
    await this.log(new LogEntry(init))
  }

  /** Append a command entry without an execution (history -s). */
  async logCommandText(command: string, session: string, cwd?: string): Promise<void> {
    const init: LogEntryInit = {
      type: EVENT_COMMAND,
      session,
      timestamp: this.nowMs(),
      command,
    }
    if (cwd !== undefined) init.cwd = cwd
    await this.log(new LogEntry(init))
  }

  /** Append a clear tombstone for a session (history -c). */
  async logClear(session: string): Promise<void> {
    await this.log(new LogEntry({ type: EVENT_CLEAR, session, timestamp: this.nowMs() }))
  }

  /** Append a delete event for one listing entry (history -d). */
  async logDelete(session: string, offset: number): Promise<void> {
    await this.log(new LogEntry({ type: EVENT_DELETE, session, timestamp: this.nowMs(), offset }))
  }

  /**
   * All recorded events, in timestamp order: every session's, or only
   * `session`'s, read from its own log alone. Stable over the per-file
   * line order, so events that share a millisecond (one line's ops plus
   * its command entry) keep append order.
   */
  async events(session?: string): Promise<EventDict[]> {
    const out = parseFiles(
      await (session === undefined
        ? this._store.readAll()
        : this._store.readMatching(`/${await sessionFile(session)}`)),
    )
    out.sort((a, b) => eventTimestamp(a) - eventTimestamp(b))
    return out
  }

  /**
   * The command events of every session's ended lines, in the order they
   * ended: a line enters its history once its result is in, and an entry
   * added without running (`history -s`) at once, so the listing only ever
   * grows at its end.
   */
  async commandEvents(): Promise<EventDict[]> {
    const ended: EventDict[] = []
    const running = new Map<unknown, EventDict>()
    for (const e of await this.events()) {
      if (e.type === EVENT_COMMAND && e.id === undefined) {
        ended.push(e)
      } else if (e.type === EVENT_COMMAND) {
        running.set(e.id, e)
      } else if (e.type === EVENT_RESULT) {
        const started = running.get(e.parent)
        if (started !== undefined) ended.push(started)
        running.delete(e.parent)
      }
    }
    return ended
  }

  /**
   * One session's visible history listing, append order. Projects the
   * session's events: a line joins the listing when its result is in (an
   * entry added without running, `history -s`, at once), a clear
   * tombstone empties it, and delete events apply at the position they
   * were issued (history -d renumbers subsequent entries, GNU behavior).
   */
  async sessionCommandEvents(session: string): Promise<EventDict[]> {
    const entries = parseFiles(await this._store.readMatching(`/${await sessionFile(session)}`))
    let visible: EventDict[] = []
    const running = new Map<unknown, EventDict>()
    for (const e of entries) {
      if (e.type === EVENT_COMMAND && e.id === undefined) {
        visible.push(e)
      } else if (e.type === EVENT_COMMAND) {
        running.set(e.id, e)
      } else if (e.type === EVENT_RESULT) {
        const started = running.get(e.parent)
        if (started !== undefined) visible.push(started)
        running.delete(e.parent)
      } else if (e.type === EVENT_CLEAR) {
        visible = []
      } else if (e.type === EVENT_DELETE) {
        const offset = typeof e.offset === 'number' ? e.offset : 0
        const idx = offset > 0 ? offset - 1 : visible.length + offset
        if (idx >= 0 && idx < visible.length) visible.splice(idx, 1)
      }
    }
    return visible
  }

  /**
   * Rewind the recorder to a snapshot's events. Clears the store first,
   * mirroring `ws.cache.clear()` on the checkout path: restoring means
   * becoming the snapshot, so events from the pre-restore timeline do
   * not survive. Foreign-format entries (e.g. the Python snapshot's
   * different history shape) without a recognized `type` are skipped:
   * the views filter by `type` so they are unusable here anyway.
   */
  async loadEvents(events: EventDict[]): Promise<void> {
    await this._store.clear()
    const written = Math.max(
      this.nowMs(),
      newestStamp(events.filter((e) => KNOWN_EVENTS.has(e.type as string))) ?? this.nowMs(),
    )
    const day = utcDateFolder(written)
    const bySession = new Map<string, string[]>()
    for (const e of events) {
      if (!KNOWN_EVENTS.has(e.type as string)) continue
      const session = typeof e.session === 'string' ? e.session : 'default'
      const lines = bySession.get(session) ?? []
      lines.push(JSON.stringify(e))
      bySession.set(session, lines)
    }
    this.newest.clear()
    for (const session of bySession.keys()) this.newest.set(session, written)
    for (const [session, lines] of bySession) {
      await this._store.write(
        `/${day}/${await sessionFile(session)}`,
        new TextEncoder().encode(lines.join('\n') + '\n'),
      )
    }
  }
}
