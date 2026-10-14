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

import { currentCaller, liveCallers, runWithCaller } from '../context/session_context.ts'
import { OpRecord, RecordIndex, STAMP_FINGERPRINT_OPS } from './record.ts'
import { underPath } from '../utils/key_prefix.ts'
import type { PathSpec } from '../types.ts'
import { currentExecutionId } from '../execution/context.ts'

/** A line's recording: its records and the mount serving them. */
export interface RecordingState {
  records: OpRecord[]
  mountId: string | null
}

/**
 * Per-task revision pins. Independent of the recording context so that
 * direct {@link Workspace.dispatch} calls (which run outside
 * {@link runWithRecording}) still honour installed pins.
 */
export interface RevisionsState {
  map: Map<string, string> | null
}

// Where the running line records its calls, with the mount serving them,
// and the revision pins, on the caller: added here, where their shapes
// live, so the caller's module imports no observe module.
declare module '../context/session_context.ts' {
  interface Caller {
    readonly recording: RecordingState | null
    readonly revisions: RevisionsState | null
  }
}

/**
 * Collect the records the running command itself emits.
 *
 * `fn` gets a fresh list that {@link record} and {@link recordStream}
 * append to, beside the line's records, while it runs. A nested call opens
 * its own list, and where async context isolates tasks (node) a concurrent
 * task keeps its own, so a pipeline stage never sees a sibling stage's
 * records; the browser's shared frame stack cannot promise that (see
 * `asyncContextIsolatesTasks`). Nothing is collected outside a recording
 * scope. Each record also reaches the list of the nearest call made with
 * `own`: a command's, which the dispatcher calls under it add to too, and
 * which takes nothing for the call around it, so a command reading
 * another's output is not charged with that command's reads. Mirrors
 * python's `command_records`.
 */
export async function commandRecords<T>(
  fn: (records: OpRecord[]) => Promise<T>,
  own = false,
): Promise<T> {
  const mine: OpRecord[] = []
  const held = currentCaller().commandSink
  const command = own ? mine : (held?.[0] ?? null)
  return runWithCaller({ ...currentCaller(), commandSink: [command, mine] }, () => fn(mine))
}

/** One lost path's mark. Mirrors Python's `LostMark`. */
export interface LostMark {
  /** Where in the line's records it was lost. */
  readonly at: number
  /** Its place among the line's marks, from 1. */
  readonly order: number
  /** The version its write lost on, if any. */
  readonly version: string | null
}

/**
 * The paths whose conditional write lost on a line. A lost path's cached
 * copy was dropped; nothing the line read of it before the loss may be
 * cached again. The version the write lost on is the one a retry sends, so
 * it is refused again until a read. A read or write of the path after the
 * loss names the bytes now there, and lifts the mark. Mirrors Python's
 * `LostPaths`, which rides the recorder; here it is keyed by the line's
 * records, since `keepVersions` runs after the recording scope ends.
 */
export class LostPaths {
  readonly marks = new Map<string, LostMark>()
  /** The marks made so far. */
  count = 0

  constructor(private readonly records: readonly OpRecord[]) {}

  mark(key: string, version: string | null = null): void {
    this.count += 1
    this.marks.set(key, {
      at: this.records.length,
      order: this.count,
      version: version !== null && version !== '' ? version : null,
    })
  }

  /**
   * Lift the marks a removal or move of `key` (and, with `subtree`, below it)
   * ended: only those made by the time it began (`upto`, the `count` then), so
   * a refusal another command of the line made while it ran stays.
   */
  lift(key: string, upto: number, subtree = false): void {
    for (const [marked, mark] of [...this.marks]) {
      const covered = marked === key || (subtree && underPath(marked, key))
      if (covered && mark.order <= upto) this.marks.delete(marked)
    }
  }

  /** The version a write to `key` lost on, while it is still lost. */
  version(key: string): string | null {
    return this.holds(key) ? (this.marks.get(key)?.version ?? null) : null
  }

  holds(key: string): boolean {
    const mark = this.marks.get(key)
    if (mark === undefined) return false
    return !this.records
      .slice(mark.at)
      .some((rec) => rec.path === key && STAMP_FINGERPRINT_OPS.has(rec.op))
  }
}

/**
 * The version the running line itself names for `key`, with whether the line
 * knows `key` at all. A lost path names the version its write lost on;
 * otherwise the newest version record does, a stamp its token and a
 * retraction none. Mirrors Python's `line_version`.
 */
export function lineVersion(
  index: RecordIndex,
  lost: LostPaths | null,
  key: string,
): [boolean, string | null] {
  if (lost?.holds(key) === true) return [true, lost.version(key)]
  const rec = index.newestVersion(key)
  if (rec === null) return [false, null]
  const fingerprint = STAMP_FINGERPRINT_OPS.has(rec.op) ? (rec.fingerprint ?? '') : ''
  return [true, fingerprint !== '' ? fingerprint : null]
}

const lostByLine = new WeakMap<readonly OpRecord[], LostPaths>()
const indexByLine = new WeakMap<readonly OpRecord[], RecordIndex>()

/** The version index of the line whose records these are; one per line. */
export function recordIndex(records: readonly OpRecord[]): RecordIndex {
  let index = indexByLine.get(records)
  if (index === undefined) {
    index = new RecordIndex(records)
    indexByLine.set(records, index)
  }
  return index
}

/** The lost paths of the line whose records these are, null outside a line. */
export function lostPaths(records: readonly OpRecord[] | undefined): LostPaths | null {
  if (records === undefined) return null
  let lost = lostByLine.get(records)
  if (lost === undefined) {
    lost = new LostPaths(records)
    lostByLine.set(records, lost)
  }
  return lost
}

/** Mark `key` lost on the running line, if one is recording. */
export function markLost(path: PathSpec, version: string | null = null): void {
  lostPaths(currentCaller().recording?.records)?.mark(path.virtual, version)
}

/** The running line's marks so far, for a later `liftLost`. Mirrors Python's `lost_count`. */
export function lostCount(): number {
  return lostPaths(currentCaller().recording?.records)?.count ?? 0
}

/** Lift the running line's marks a removal or move of `key` ended. Mirrors Python's `lift_lost`. */
export function liftLost(path: PathSpec, upto: number, subtree = false): void {
  lostPaths(currentCaller().recording?.records)?.lift(path.virtual, upto, subtree)
}

export function activeRecords(): readonly OpRecord[] | undefined {
  return currentCaller().recording?.records
}

export async function runWithRecording<T>(fn: () => Promise<T>): Promise<[T, OpRecord[]]> {
  const state: RecordingState = { records: [], mountId: null }
  const value = await runWithCaller({ ...currentCaller(), recording: state }, fn)
  return [value, state.records]
}

/**
 * Run `fn` with `mountId` as the mount its records belong to.
 *
 * Derives a state for this async branch and shares only the records array,
 * so two mounts consumed concurrently (`cat /s3/a & cat /db/b`) cannot see
 * or clobber each other's mount. Mirrors python's `push_mount_context`,
 * whose `Recorder` is frozen and re-set per task for the same reason.
 * An undefined `mountId` inherits the enclosing frame's.
 *
 * Inert (runs `fn` unchanged) when no recording context is active.
 */
export function runWithMountContext<T>(fn: () => Promise<T>, mountId?: string | null): Promise<T> {
  const state = currentCaller().recording
  if (state === null) return fn()
  return runWithCaller(
    {
      ...currentCaller(),
      recording: {
        records: state.records,
        mountId: mountId === undefined ? state.mountId : mountId,
      },
    },
    fn,
  )
}

/**
 * Wrap a stream so `mountId` is the active mount during each pull from the
 * underlying source. A command may return a stream that defers its backend
 * read to the first chunk request, by which point the mount's own scope has
 * already exited, so without this the record lands under whatever frame
 * drains it. An iterator rather than a generator: a generator queues `return`
 * behind a pull waiting for the next chunk, so the close of an idle follow
 * would never reach the source whose own close ends that wait. Mirrors
 * python's `with_mount_context`.
 */
export function withMountContext(
  it: AsyncIterable<Uint8Array>,
  mountId?: string | null,
): AsyncIterableIterator<Uint8Array> {
  const iter = it[Symbol.asyncIterator]()
  let ended = false
  const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
  return {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (ended) return done
      try {
        const step = await runWithMountContext(() => iter.next(), mountId)
        if (step.done === true) ended = true
        return step
      } catch (err) {
        ended = true
        await iter.return?.(undefined)
        throw err
      }
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      if (!ended) {
        ended = true
        await iter.return?.(undefined)
      }
      return done
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

// Whether a recording context is active. Backends that need an extra API
// call to capture fingerprint/revision metadata (Drive, Graph) gate it on
// this so unrecorded reads stay single-request.
export function recordingActive(): boolean {
  return currentCaller().recording !== null
}

export interface RecordOptions {
  fingerprint?: string | null
  revision?: string | null
}

/**
 * A running stopwatch for one op, owned by the record path.
 *
 * Opened where the backend work begins and read once when the op
 * finishes, so an op module hands this around instead of reading a
 * clock of its own. The wall-clock stamp the record carries is taken at
 * finish time, not here. Mirrors python's `OpTimer`.
 */
export class OpTimer {
  private readonly startMs: number

  constructor() {
    this.startMs = performance.now()
  }

  /** Milliseconds elapsed since the timer was opened. */
  get elapsedMs(): number {
    return Math.floor(performance.now() - this.startMs)
  }
}

/**
 * Open the record path's stopwatch for one op. Hand the timer to
 * {@link record} or {@link finishRecord} when the op completes.
 */
export function startOp(): OpTimer {
  return new OpTimer()
}

/**
 * Close `timer` and build the finished record.
 *
 * The one place an op's duration and wall-clock stamp are read, shared
 * by the recorder sink ({@link record}) and by the `Files` facade's own
 * ledger, so the two cannot disagree about what a duration measures.
 * `path` is stored as given.
 */
export function finishRecord(
  op: string,
  path: string,
  source: string,
  nbytes: number,
  timer: OpTimer,
  options: RecordOptions = {},
): OpRecord {
  const elapsed = timer.elapsedMs
  return new OpRecord({
    op,
    path,
    source,
    bytes: nbytes,
    timestamp: Date.now(),
    durationMs: elapsed,
    fingerprint: options.fingerprint ?? null,
    revision: options.revision ?? null,
    mountId: currentCaller().recording?.mountId ?? null,
    executionId: currentExecutionId(),
  })
}

function charge(rec: OpRecord): void {
  const held = currentCaller().commandSink
  if (held !== null) {
    held[1].push(rec)
    if (held[0] !== null && held[0] !== held[1]) held[0].push(rec)
  }
}

/**
 * Append a finished record to the active recording, if any.
 *
 * `path`: the full virtual path.
 */
export function record(
  op: string,
  path: string,
  source: string,
  nbytes: number,
  timer: OpTimer,
  options: RecordOptions = {},
): void {
  const state = currentCaller().recording
  if (state === null) return
  const rec = finishRecord(op, path, source, nbytes, timer, options)
  state.records.push(rec)
  charge(rec)
}

/**
 * Append a streaming record whose bytes are filled in as it drains.
 *
 * `path`: the full virtual path.
 */
export function recordStream(
  op: string,
  path: string,
  source: string,
  options: RecordOptions = {},
): OpRecord | null {
  const state = currentCaller().recording
  if (state === null) return null
  const rec = new OpRecord({
    op,
    path,
    source,
    bytes: 0,
    timestamp: Date.now(),
    durationMs: 0,
    fingerprint: options.fingerprint ?? null,
    revision: options.revision ?? null,
    mountId: currentCaller().recording?.mountId ?? null,
    executionId: currentExecutionId(),
  })
  state.records.push(rec)
  charge(rec)
  return rec
}

/**
 * Run `fn` inside a revisions context. Backend read functions inside
 * `fn` (or any async chain it starts) can consult {@link revisionFor}
 * to look up a pin. Independent of {@link runWithRecording} so that
 * direct {@link Workspace.dispatch} calls (which don't open a recording
 * scope) still honour installed pins.
 *
 * Task-isolated via AsyncLocalStorage: concurrent runs on different
 * mounts each see their own pin map.
 */
export function runWithRevisions<T>(
  revisions: Map<string, string> | null,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithCaller({ ...currentCaller(), revisions: { map: revisions } }, fn)
}

/**
 * Look up the active revision pin for `path`, or null if no pin is
 * installed (or no revisions context is active).
 *
 * Every live frame's map is searched, because pins are mount state
 * threaded through the context only for reach: each bind hands over
 * the mount's own map, keyed by full virtual path, so a hit is never
 * another task's different pin — the same mount binds the same map,
 * and another mount's map cannot hold this path. On the fallback
 * storage this is what keeps a pinned read pinned while an unpinned
 * op's frame shadows the newest slot.
 */
export function revisionFor(path: string): string | null {
  for (const state of liveCallers().flatMap((caller) =>
    caller.revisions === null ? [] : [caller.revisions],
  )) {
    const pin = state.map?.get(path)
    if (pin !== undefined) return pin
  }
  return null
}
