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
  context,
  isSpanContextValid,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api'
import { HISTORY_MAX_RECORDS } from '../execution/constants.ts'
import type { Job } from '../execution/job/types.ts'
import type { Process } from '../execution/process/types.ts'
import { ProcessId, type MachineName } from '../execution/types.ts'
import { CHUNK_SIZE } from '../io/cooperative.ts'
import type { IOResult } from '../io/types.ts'
import { YieldBudget } from '../io/yield_budget.ts'
import type { JsonObject } from '../types.ts'
import { SystemClock, type Clock } from '../utils/clock.ts'
import { utcDateFolder } from '../utils/dates.ts'
import { sha256Hex } from '../utils/hash.ts'
import { compareCodePoints } from '../utils/sort.ts'
import {
  EVENT_CLEAR,
  EVENT_COMMAND,
  EVENT_DELETE,
  EVENT_RESULT,
  EVENT_VFS,
  LogEntry,
  STDOUT_TRUNCATE,
  type LogEntryInit,
} from './log_entry.ts'
import {
  NAME_LIMIT,
  TRACE_CONTENT_ENV,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_CONTENT_MAX_BYTES_ENV,
  TRACE_MAX_SPANS,
  TRACE_MAX_SPANS_ENV,
  TRACER_NAME,
} from './constants.ts'
import type { OpRecord } from './record.ts'
import { RAMObserverStore, type ObserverStore } from './store.ts'

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

function envVar(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]?.trim()
}

/** Whether spans carry content: on unless TRACE_CONTENT_ENV turns it off. */
function traceContent(): boolean {
  const value = envVar(TRACE_CONTENT_ENV)?.toLowerCase()
  return value !== 'false' && value !== '0'
}

function positiveEnv(name: string, fallback: number): number {
  const value = envVar(name) ?? ''
  const limit = /^\d+$/.test(value) ? Number(value) : 0
  return limit > 0 ? limit : fallback
}

function traceContentMaxBytes(): number {
  return positiveEnv(TRACE_CONTENT_MAX_BYTES_ENV, TRACE_CONTENT_MAX_BYTES)
}

/**
 * The bytes of each stream a line's terminal keeps for its record while a
 * reader takes the line: CHUNK_SIZE, or the span's cap when content is
 * traced and the cap is larger. Mirrors Python's `kept_output_bytes`.
 */
export function keptOutputBytes(): number {
  return traceContent() ? Math.max(CHUNK_SIZE, traceContentMaxBytes()) : CHUNK_SIZE
}

/**
 * The start of `raw` as text of at most `limit` bytes in UTF-8. A byte
 * that isn't UTF-8 reads as U+FFFD, three bytes, so the text is cut
 * again after decoding, before the character that would cross `limit`.
 * Mirrors Python's `_traced_output`.
 */
function tracedOutput(raw: Uint8Array, limit: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const text = decoder.decode(raw.subarray(0, limit))
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= limit) return text
  let end = limit
  // Back to the first byte of the character `limit` falls inside.
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--
  return decoder.decode(encoded.subarray(0, end))
}

/**
 * The tracer a finished line goes to: a no-op until the process sets up
 * an OpenTelemetry SDK, whose exporter picks the backend.
 */
function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME)
}

/**
 * Open a typed line's `command` span as it starts (`start`, epoch
 * milliseconds), naming the line, its session, its workspace, the host
 * running Mirage (`host.name`) and the cwd it starts in; the spans of its jobs
 * and processes go under it. Mirrors Python's `_start_line`.
 */
function startLine(
  workspaceId: string | undefined,
  machine: string | undefined,
  line: string,
  session: string,
  command: string,
  cwd: string | undefined,
  start: number,
): Span {
  const attributes: Attributes = {
    'mirage.line.id': line,
    'mirage.session.id': session,
    'mirage.command': command,
    'mirage.timestamp': start,
  }
  if (workspaceId !== undefined) attributes['mirage.workspace.id'] = workspaceId
  if (machine !== undefined) attributes['host.name'] = machine
  if (cwd !== undefined) attributes['mirage.cwd'] = cwd
  return tracer().startSpan('command', { startTime: start, attributes })
}

/**
 * Close a typed line's `command` span (`span`, its start and end in epoch
 * milliseconds): how it ended, the start of its stdout and stderr
 * (`output`, as it wrote them), and a `vfs.<call>` span for each call it
 * made to a mount, under the span of the process that made it (`under`),
 * else under the line's. Each span also carries its start or end and its
 * length in milliseconds, as the history's entries have them, for a tracer
 * that can't be given a span's times. TRACE_CONTENT_ENV leaves out the
 * output and the calls, and past TRACE_MAX_SPANS_ENV calls the rest are
 * only counted. Mirrors Python's `_end_line`.
 */
function endLine(
  line: Span,
  span: [number, number],
  exitCode: number,
  output: [Uint8Array, Uint8Array],
  records: readonly OpRecord[],
  under: (rec: OpRecord) => Context | undefined,
): void {
  const content = traceContent()
  line.setAttribute('mirage.exit_code', exitCode)
  line.setAttribute('mirage.duration_ms', span[1] - span[0])
  const calls = records.slice(0, positiveEnv(TRACE_MAX_SPANS_ENV, TRACE_MAX_SPANS))
  if (content) {
    const limit = traceContentMaxBytes()
    line.setAttribute('mirage.stdout', tracedOutput(output[0], limit))
    line.setAttribute('mirage.stderr', tracedOutput(output[1], limit))
    if (calls.length < records.length)
      line.setAttribute('mirage.vfs.dropped', records.length - calls.length)
  }
  if (content && line.isRecording()) {
    const parent = trace.setSpan(context.active(), line)
    for (const rec of calls) {
      const call = tracer().startSpan(
        `vfs.${rec.op}`,
        {
          startTime: rec.timestamp - rec.durationMs,
          attributes: {
            'mirage.vfs.path': rec.path,
            'mirage.vfs.source': rec.source,
            'mirage.vfs.bytes': rec.bytes,
            'mirage.vfs.timestamp': rec.timestamp,
            'mirage.vfs.duration_ms': rec.durationMs,
          },
        },
        under(rec) ?? parent,
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

function parseFiles(files: Map<string, Uint8Array>): JsonObject[] {
  const out: JsonObject[] = []
  const decoder = new TextDecoder('utf-8', { fatal: false })
  for (const key of [...files.keys()].sort(compareCodePoints)) {
    if (!key.endsWith('.jsonl')) continue
    const text = decoder.decode(files.get(key))
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as JsonObject)
      } catch (err) {
        // A crash mid-append tears a line and the entry appended onto it.
        if (!(err instanceof SyntaxError)) throw err
        logger.debug?.(`skipping unparseable history line in ${key}: ${String(err)}`)
      }
    }
  }
  return out
}

/** The latest timestamp among `events`, null when none carries one. */
function newestStamp(events: readonly JsonObject[]): number | null {
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
 * Each typed line also goes to OpenTelemetry as a span, and so does each job
 * and process once it ends: a process under the one that started it, a job's
 * process under its job, and the line's own under the line's span while the
 * newest `HISTORY_MAX_RECORDS` lines' spans are known, each vfs call under
 * the process that made it. A process links to each it reads from,
 * `mirage.input` naming where: its `stdin`, a `/dev/fd` path or its `argv`.
 * Nothing leaves the process until an SDK is set up. Tracing stops at the workspace's own machine and runtimes: a program
 * a runtime runs elsewhere starts no trace of its own there. `machine` is
 * the host running Mirage, `host.name` on its command, job and process spans;
 * `processes` gives the process records the workspace keeps, which a span
 * goes under, and `instance` what each machine's provider calls it,
 * `mirage.machine.id` for a record that does not say.
 */
export class Observer {
  private readonly _store: ObserverStore
  private readonly clock: Clock
  private readonly newest = new Map<string, number | null>()
  // Each open line's start (epoch ms, then monotonic) and span.
  private readonly started = new Map<string, [number, number, Span]>()
  // The span of each recent line, which its jobs and processes go under,
  // oldest first.
  private readonly lineSpans = new Map<string, SpanContext>()
  // The span of each job and process open now, by kind, line and pid, and
  // of the newest ended ones, which one started under them still goes
  // under, oldest first.
  private readonly openSpans = new Map<string, Span>()
  private readonly closedSpans = new Map<string, SpanContext>()
  // The pid each of those processes shows, by the same key: its program's
  // on its machine, else Mirage's own.
  private readonly shownPids = new Map<string, number>()

  constructor(
    store?: ObserverStore,
    clock: Clock = new SystemClock(),
    private readonly workspaceId?: string,
    private readonly machine?: string,
    private readonly processes?: () => Process[],
    private readonly instance?: (machine: MachineName) => string,
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
    if (line !== undefined) {
      const span = startLine(
        this.workspaceId,
        this.machine,
        line,
        session,
        command,
        cwd,
        init.timestamp,
      )
      this.started.set(line, [init.timestamp, began, span])
      this.lineSpans.set(line, span.spanContext())
      for (const oldest of this.lineSpans.keys()) {
        if (this.lineSpans.size <= HISTORY_MAX_RECORDS) break
        this.lineSpans.delete(oldest)
      }
    }
  }

  /**
   * Send an ended process to OpenTelemetry as a `process` span: what it ran,
   * where and as whom, how it ended, and a link to each process it read
   * from, whose span is known by then. Mirrors Python's `trace_process`.
   */
  traceProcess(record: Process): void {
    const line = record.line?.value ?? null
    if (!this.traced(line)) return
    const span = this.processSpan(record)
    if (record.exit !== null) span.setAttribute('process.exit.code', record.exit)
    if (record.signal !== null) span.setAttribute('mirage.signal', record.signal)
    if (record.error !== null) span.setAttribute('mirage.error', record.error)
    const inputs: [string, number][] = record.stdin == null ? [] : [['stdin', record.stdin]]
    for (const [fd, pid] of Object.entries(record.fd ?? {})) inputs.push([`/dev/fd/${fd}`, pid])
    for (const pid of record.argv ?? []) inputs.push(['argv', pid])
    for (const [value, pid] of inputs) {
      const known = this.known(record, pid)
      if (known !== undefined)
        span.addLink({ context: known, attributes: { 'mirage.input': value } })
    }
    const shown = record.machinePid?.pid ?? record.id.pid
    span.setAttribute('process.pid', shown)
    for (const [key, value] of Object.entries(
      this.machineAttributes(record.machine, record.machineInstance ?? null),
    )) {
      if (value !== undefined) span.setAttribute(key, value)
    }
    this.shownPids.set(this.spanKey('process', line, record.id.pid), shown)
    this.endSpan(this.spanKey('process', line, record.id.pid), record.endedAt)
  }

  /**
   * Send a job to OpenTelemetry as a `job` span, opened as it starts, so its
   * process goes under it, and closed as it ends: what it ran, where and as
   * whom, and how it ended; `process` is its process's record, which names
   * where its program runs once it does. Mirrors Python's `trace_job`.
   */
  traceJob(record: Job, process: Process | null): void {
    const line = record.line?.value ?? null
    if (!this.traced(line)) return
    const span = this.jobSpan(record, process)
    if (record.endedAt === null) return
    if (process !== null) {
      span.setAttribute('process.pid', process.machinePid?.pid ?? process.id.pid)
      for (const [key, value] of Object.entries(
        this.machineAttributes(process.machine, process.machineInstance ?? null),
      )) {
        if (value !== undefined) span.setAttribute(key, value)
      }
    }
    if (record.exit !== null) span.setAttribute('mirage.exit_code', record.exit)
    if (record.signal !== null) span.setAttribute('mirage.signal', record.signal)
    this.endSpan(this.spanKey('job', line, record.pid ?? 0), record.endedAt)
  }

  /**
   * Whether anyone traces the line: not when its span is one nobody records,
   * so an untraced workspace reads no records. Mirrors Python's `_traced`.
   */
  private traced(line: string | null): boolean {
    const known = line === null ? undefined : this.lineSpans.get(line)
    return known === undefined || isSpanContextValid(known)
  }

  /**
   * The attributes naming where a span's work ran: the machine's provider,
   * its name and what its provider calls it (`instance`, as the record kept
   * it when the work started, else asked now). Mirrors Python's
   * `_machine_attributes`.
   */
  private machineAttributes(machine: MachineName, instance: string | null = null): Attributes {
    return {
      'mirage.machine.type': machine.provider,
      'mirage.machine.name': machine.name,
      'mirage.machine.id': instance ?? this.instance?.(machine) ?? machine.name,
    }
  }

  /** The key a job's or process's span is kept under: its kind, line and pid. */
  private spanKey(kind: string, line: string | null, pid: number): string {
    return `${kind} ${line ?? ''} ${String(pid)}`
  }

  /**
   * The context a span goes under to be under the span `key` names,
   * undefined while there is none. Mirrors Python's `_context`.
   */
  private contextOf(key: string): Context | undefined {
    const span = this.openSpans.get(key)
    if (span !== undefined) return trace.setSpan(context.active(), span)
    const known = this.closedSpans.get(key)
    return known === undefined ? undefined : trace.setSpanContext(context.active(), known)
  }

  /**
   * The context `record`'s span goes under: its parent's span, opened now
   * when its parent still runs, else its line's. Mirrors Python's `_under`.
   */
  private under(record: Process): Context | undefined {
    const line = record.line?.value ?? null
    if (record.parent !== null) {
      const found = this.contextOf(this.spanKey('process', line, record.parent))
      if (found !== undefined) return found
      const parent = (this.processes?.() ?? []).find(
        (p) =>
          p.id.pid === record.parent && (p.line?.value ?? null) === line && p.state !== 'exited',
      )
      if (parent !== undefined) return trace.setSpan(context.active(), this.processSpan(parent))
    }
    const known = line === null ? undefined : this.lineSpans.get(line)
    return known === undefined ? undefined : trace.setSpanContext(context.active(), known)
  }

  /**
   * The span of the process `pid` of `record`'s line, opened now when it
   * still runs, undefined when it is not known. Mirrors Python's `_known`.
   */
  private known(record: Process, pid: number): SpanContext | undefined {
    const line = record.line?.value ?? null
    const key = this.spanKey('process', line, pid)
    const open = this.openSpans.get(key)
    if (open !== undefined) return open.spanContext()
    const closed = this.closedSpans.get(key)
    if (closed !== undefined) return closed
    const other = (this.processes?.() ?? []).find(
      (p) => p.id.pid === pid && (p.line?.value ?? null) === line,
    )
    return other === undefined ? undefined : this.processSpan(other).spanContext()
  }

  /**
   * `record`'s span, opened the first time it is needed (as it ends, or as
   * the first process under it does) from its own start: under its job's
   * span when it is a job's process, else under its parent's or its line's.
   * Mirrors Python's `_process_span`.
   */
  private processSpan(record: Process): Span {
    const line = record.line?.value ?? null
    const key = this.spanKey('process', line, record.id.pid)
    const open = this.openSpans.get(key)
    if (open !== undefined) return open
    const under = this.contextOf(this.spanKey('job', line, record.id.pid)) ?? this.under(record)
    const shown = record.machinePid?.pid ?? record.id.pid
    this.shownPids.set(this.spanKey('process', line, record.id.pid), shown)
    const attributes: Attributes = {
      'process.pid': shown,
      'mirage.process.pid': record.id.pid,
      'process.command_line': record.command,
      'process.group_leader.pid':
        this.shownPids.get(this.spanKey('process', line, record.group)) ?? record.group,
      ...this.machineAttributes(record.machine, record.machineInstance ?? null),
      'mirage.workspace.id': record.id.workspaceId,
      'mirage.session.id': record.sessionId,
      'mirage.cwd': record.cwd.virtual,
    }
    if (record.parent !== null) {
      attributes['process.parent_pid'] =
        this.shownPids.get(this.spanKey('process', line, record.parent)) ?? record.parent
    }
    if (record.runtime !== null) attributes['mirage.runtime'] = record.runtime
    return this.startSpan('process', key, line, attributes, under, record.startedAt)
  }

  /**
   * `record`'s span, opened the first time it is needed from its own start,
   * under the span its process would go under. Mirrors Python's `_job_span`.
   */
  private jobSpan(record: Job, process: Process | null): Span {
    const line = record.line?.value ?? null
    const key = this.spanKey('job', line, record.pid ?? 0)
    const open = this.openSpans.get(key)
    if (open !== undefined) return open
    let under: Context | undefined
    if (process !== null) under = this.under(process)
    else if (line !== null) {
      const known = this.lineSpans.get(line)
      if (known !== undefined) under = trace.setSpanContext(context.active(), known)
    }
    const attributes: Attributes = {
      'mirage.job.id': record.id.console,
      'mirage.job.number': record.number,
      'mirage.command': record.command,
      'mirage.workspace.id': record.id.workspaceId,
      'mirage.session.id': record.sessionId,
      'mirage.cwd': record.cwd,
    }
    if (process !== null) {
      Object.assign(
        attributes,
        this.machineAttributes(process.machine, process.machineInstance ?? null),
      )
    }
    if (record.pid !== null) {
      attributes['process.pid'] = process?.machinePid?.pid ?? record.pid
      attributes['mirage.process.pid'] = record.pid
    }
    return this.startSpan('job', key, line, attributes, under, record.startedAt)
  }

  /**
   * Open the `name` span of a job or process from `startedAt` (epoch
   * seconds), naming the host and its line, under `under` (a trace of its
   * own when undefined), and keep it open under `key`. Mirrors Python's
   * `_start`.
   */
  private startSpan(
    name: string,
    key: string,
    line: string | null,
    attributes: Attributes,
    under: Context | undefined,
    startedAt: number,
  ): Span {
    if (this.machine !== undefined) attributes['host.name'] = this.machine
    if (line !== null) attributes['mirage.line.id'] = line
    const span = tracer().startSpan(
      name,
      { startTime: startedAt * 1000, attributes },
      under ?? context.active(),
    )
    this.openSpans.set(key, span)
    return span
  }

  /**
   * Close the open span `key` names as of `endedAt` (epoch seconds; null
   * ends it now), keeping its context for what started under it and ends
   * later. Mirrors Python's `_end`.
   */
  private endSpan(key: string, endedAt: number | null): void {
    const span = this.openSpans.get(key)
    if (span === undefined) return
    this.openSpans.delete(key)
    span.end(endedAt === null ? undefined : endedAt * 1000)
    this.closedSpans.delete(key)
    this.closedSpans.set(key, span.spanContext())
    for (const oldest of this.closedSpans.keys()) {
      if (this.closedSpans.size <= HISTORY_MAX_RECORDS) break
      this.closedSpans.delete(oldest)
      this.shownPids.delete(oldest)
    }
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
    const out = await io.materializeStdout()
    const err = await io.materializeStderr()
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const stdout = decoder.decode(out).slice(0, STDOUT_TRUNCATE)
    const stderr = decoder.decode(err).slice(0, STDOUT_TRUNCATE)
    const now = this.nowMs()
    const took =
      started === undefined ? undefined : Math.round((this.clock.monotonic() - started[1]) * 1000)
    if (started !== undefined && took !== undefined) {
      endLine(
        started[2],
        [started[0], started[0] + took],
        io.exitCode,
        [out, err],
        opRecords,
        (rec) =>
          rec.process === null
            ? undefined
            : this.contextOf(
                this.spanKey('process', line ?? null, ProcessId.parse(rec.process).pid),
              ),
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

  /**
   * Append a delete event for one listing entry (history -d), the one at
   * `index` in `listing`. The event names the entry by its timestamp and
   * text and by how many entries alike in both follow it, counted from the
   * newest end, so a store that drops its oldest lines never turns it on
   * another entry.
   */
  async logDelete(session: string, listing: readonly JsonObject[], index: number): Promise<void> {
    const entry = listing[index] ?? {}
    const alike = (e: JsonObject): boolean =>
      e.timestamp === entry.timestamp && e.command === entry.command
    await this.log(
      new LogEntry({
        type: EVENT_DELETE,
        session,
        timestamp: this.nowMs(),
        command: typeof entry.command === 'string' ? entry.command : '',
        target: typeof entry.timestamp === 'number' ? entry.timestamp : 0,
        after: listing.slice(index + 1).filter(alike).length,
      }),
    )
  }

  /**
   * All recorded events, in timestamp order: every session's, or only
   * `session`'s, read from its own log alone. Stable over the per-file
   * line order, so events that share a millisecond (one line's ops plus
   * its command entry) keep append order.
   */
  async events(session?: string): Promise<JsonObject[]> {
    const out = parseFiles(
      await (session === undefined
        ? this._store.readAll()
        : this._store.readMatching(`/${await sessionFile(session)}`)),
    )
    out.sort(
      (a, b) =>
        (typeof a.timestamp === 'number' ? a.timestamp : 0) -
        (typeof b.timestamp === 'number' ? b.timestamp : 0),
    )
    return out
  }

  /**
   * The command events of every session's ended lines, in the order they
   * ended: a line enters its history once its result is in, and an entry
   * added without running (`history -s`) at once, so the listing only ever
   * grows at its end.
   */
  async commandEvents(): Promise<JsonObject[]> {
    const ended: JsonObject[] = []
    const running = new Map<unknown, JsonObject>()
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
   * tombstone empties it, and a delete event drops the entry it names
   * (history -d renumbers subsequent entries, GNU behavior).
   */
  async sessionCommandEvents(session: string): Promise<JsonObject[]> {
    const entries = parseFiles(await this._store.readMatching(`/${await sessionFile(session)}`))
    let visible: JsonObject[] = []
    const running = new Map<unknown, JsonObject>()
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
        let skip = typeof e.after === 'number' ? e.after : 0
        for (let idx = visible.length - 1; idx >= 0; idx--) {
          const entry = visible[idx]
          if (entry === undefined || entry.timestamp !== e.target || entry.command !== e.command) {
            continue
          }
          if (skip === 0) {
            visible.splice(idx, 1)
            break
          }
          skip--
        }
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
  async loadEvents(events: JsonObject[]): Promise<void> {
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
