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

import type { IOResult } from '../io/types.ts'
import { utcDateFolder } from '../utils/dates.ts'
import { SystemClock, type Clock } from '../utils/clock.ts'
import {
  EVENT_CLEAR,
  EVENT_COMMAND,
  EVENT_DELETE,
  EVENT_OP,
  LogEntry,
  type LogEntryInit,
  STDOUT_TRUNCATE,
} from './log_entry.ts'
import type { OpRecord } from './record.ts'
import { type ObserverStore, RAMObserverStore } from './store.ts'
import { compareCodePoints } from '../utils/sort.ts'
import { currentExecutionId } from '../context/session_context.ts'

/**
 * Opt in by assigning a debug sink, as Python's module logger is off until
 * configured: history is read after every command, and a torn line stays in
 * the file, so a sink that always wrote would repeat it on every read.
 */
export const logger: { debug?: (message: string) => void } = {}

const KNOWN_EVENTS = new Set<string>([EVENT_COMMAND, EVENT_CLEAR, EVENT_DELETE, EVENT_OP])

export type EventDict = Record<string, unknown>

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
 */
export class Observer {
  private readonly _store: ObserverStore
  private readonly clock: Clock
  private readonly newest = new Map<string, number | null>()

  constructor(store?: ObserverStore, clock: Clock = new SystemClock()) {
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
    const found = newestStamp(parseFiles(await this._store.readMatching(`/${session}.jsonl`)))
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
    await this._store.append(`/${utcDateFolder(stamped.timestamp)}/${stamped.session}.jsonl`, line)
  }

  async logOp(rec: OpRecord, session: string, cwd?: string): Promise<void> {
    await this.log(LogEntry.fromOpRecord(rec, session, cwd))
  }

  /**
   * Record one finished typed line: its ops, then its command. The line
   * reader's single recording call: every op the line emitted lands
   * first, then the command entry itself.
   */
  async logExecution(
    command: string,
    io: IOResult,
    opRecords: OpRecord[],
    session: string,
    cwd?: string,
  ): Promise<void> {
    // TODO: batch the op lines and the command line into a single
    // store.append so one typed line costs one roundtrip and lands
    // atomically in the store.
    for (const rec of opRecords) {
      await this.logOp(rec, session, cwd)
    }
    const stdout = await io.materializeStdout()
    const text = new TextDecoder('utf-8', { fatal: false }).decode(stdout).slice(0, STDOUT_TRUNCATE)
    const init: LogEntryInit = {
      type: EVENT_COMMAND,
      session,
      timestamp: this.nowMs(),
      command,
      exitCode: io.exitCode,
      stdout: text,
    }
    if (cwd !== undefined) init.cwd = cwd
    const executionId = currentExecutionId()
    if (executionId !== null) init.executionId = executionId
    await this.log(new LogEntry(init))
  }

  /** Append a command entry without an execution (history -s). */
  async logCommandText(command: string, session: string, cwd?: string): Promise<void> {
    const init: LogEntryInit = {
      type: EVENT_COMMAND,
      session,
      timestamp: this.nowMs(),
      command,
      exitCode: 0,
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
   * All recorded events across sessions, in timestamp order. Stable over
   * the per-file line order, so events that share a millisecond (one
   * line's ops plus its command entry) keep append order.
   */
  async events(): Promise<EventDict[]> {
    const out = parseFiles(await this._store.readAll())
    out.sort((a, b) => eventTimestamp(a) - eventTimestamp(b))
    return out
  }

  /** Command events across all sessions, in append order. */
  async commandEvents(): Promise<EventDict[]> {
    return (await this.events()).filter((e) => e.type === EVENT_COMMAND)
  }

  /**
   * One session's visible history listing, append order. Projects the
   * session's events: commands after the last clear tombstone, with
   * delete events applied at the position they were issued (history -d
   * renumbers subsequent entries, GNU behavior).
   */
  async sessionCommandEvents(session: string): Promise<EventDict[]> {
    const entries = parseFiles(await this._store.readMatching(`/${session}.jsonl`))
    let lastClear = -1
    entries.forEach((e, i) => {
      if (e.type === EVENT_CLEAR) lastClear = i
    })
    const visible: EventDict[] = []
    for (const e of entries.slice(lastClear + 1)) {
      if (e.type === EVENT_COMMAND) {
        visible.push(e)
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
        `/${day}/${session}.jsonl`,
        new TextEncoder().encode(lines.join('\n') + '\n'),
      )
    }
  }
}
