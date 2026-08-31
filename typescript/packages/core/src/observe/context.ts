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

import { asyncContextIsolatesTasks, createAsyncContext } from '../utils/async_context.ts'
import { OpRecord } from './record.ts'
import { rstripSlash } from '../utils/slash.ts'

interface RecordingState {
  records: OpRecord[]
  mountPrefix: string
}

const storage = createAsyncContext<RecordingState>()

/**
 * Per-task revision pins. Independent of the recording context so that
 * direct {@link Workspace.dispatch} calls (which run outside
 * {@link runWithRecording}) still honour installed pins.
 */
interface RevisionsState {
  map: Map<string, string> | null
}

const revisionsStorage = createAsyncContext<RevisionsState>()

export async function runWithRecording<T>(fn: () => Promise<T>): Promise<[T, OpRecord[]]> {
  const state: RecordingState = { records: [], mountPrefix: '' }
  const value = await storage.run(state, fn)
  return [value, state.records]
}

export interface RecordedRun<T> {
  /** The frame's own records array, appended to as `done` progresses. */
  records: OpRecord[]
  /** What `fn` settled to, resolved or rejected. */
  done: Promise<T>
}

/**
 * The tail of the serialized frames, null when none is live.
 *
 * Only read on a storage that cannot isolate tasks; see
 * {@link runRecorded} for why that mode needs a queue at all.
 */
let recordedTail: Promise<void> | null = null

/**
 * Open a recording frame and hand back that frame's records array
 * *and* the pending result, so the caller holds both whether `fn`
 * resolves or throws.
 *
 * {@link runWithRecording} answers the array only on the success path,
 * and reading it back with {@link activeRecords} from inside the
 * callback is not the same array under {@link FallbackStorage}, whose
 * single stack answers the newest live frame rather than this one —
 * which is exactly the interleaving this frame exists to isolate. The
 * array is returned synchronously, before anything can bind over it,
 * so it names this frame in both storage modes.
 *
 * Naming the array is not enough on its own, though, and this is why
 * these frames **serialize** when
 * {@link asyncContextIsolatesTasks} is false. `record()` routes by
 * `getStore()`, which on the fallback answers whichever frame is
 * newest, so a record emitted after an `await` inside frame A lands in
 * frame B if B bound while A was suspended: A keeps its own array and
 * finds it empty, which reads as "this file has no identity". No amount
 * of filtering recovers a record that was never appended here, so
 * instead no two of these frames are ever live at once — the second
 * caller waits for the first to settle. That makes concurrent identity
 * reads correct rather than best-effort, on the same path as on a
 * different one, at the cost of running them one at a time on a runtime
 * that could not have run them in parallel correctly anyway.
 *
 * On an isolating runtime (node's `AsyncLocalStorage`) the queue is
 * skipped entirely: `fn` starts synchronously, as before, and
 * concurrent reads keep overlapping.
 *
 * The **enclosing** frame is this function's business too, and that is
 * why the caller no longer names it: what the frame collects is handed
 * up on the way out, and the array to hand it to can only be read at
 * the instant the frame binds. See {@link bindFrame}.
 *
 * One constraint follows from the queue: a serialized frame must not
 * open another one inside itself, since it would be waiting for its own
 * settle. There is one caller ({@link Ops.readFileWithIdentity}) and it
 * does not nest.
 *
 * Ordinary {@link runWithRecording} frames deliberately do NOT join
 * this queue: an identity read runs *inside* an executing command's
 * frame, so a queue spanning both kinds would have the inner frame
 * waiting for its own encloser to settle — a deadlock, not a fix. The
 * residual window on a fallback runtime is therefore an ordinary frame
 * opened while an identity read awaits its backend: that read's record
 * lands in the newer frame and the read answers null. Null is the safe
 * side — the path filter in {@link readIdentity} means an identity can
 * be missing but never someone else's — and a null identity is exactly
 * the marker-less case every consumer already handles by hashing. On an
 * isolating runtime none of this applies.
 */
export function runRecorded<T>(fn: () => Promise<T>): RecordedRun<T> {
  const state: RecordingState = { records: [], mountPrefix: '' }
  if (asyncContextIsolatesTasks) return { records: state.records, done: bindFrame(state, fn) }
  // An idle queue still binds synchronously: no other serialized frame
  // is live, so there is nothing to wait behind, and `fn` starts where
  // it always did. A live one is waited out first.
  const done: Promise<T> =
    recordedTail === null ? bindFrame(state, fn) : recordedTail.then(() => bindFrame(state, fn))
  // The queue only sequences; `done` is what carries the outcome to the
  // caller, so the tail settles on either path rather than rejecting
  // with nobody left to hear it. It is cleared when this frame is the
  // last one out, so the next caller binds synchronously again.
  const tail = done.then(
    () => undefined,
    () => undefined,
  )
  recordedTail = tail
  void tail.then(() => {
    if (recordedTail === tail) recordedTail = null
  })
  return { records: state.records, done }
}

/**
 * One recording frame, bound now, and handed up to its enclosing frame
 * when it settles.
 *
 * `storage.run` may hand back a value or a promise, and a thunk that
 * throws before returning one still has to settle `done`, so the caller
 * has a single handling path for both.
 *
 * The enclosing frame is read **here**, one line before `storage.run`,
 * and never by the caller of {@link runRecorded}. Both halves of that
 * matter, for a different reason per storage:
 *
 * - On {@link FallbackStorage} the caller's line runs when the caller
 *   runs, which on a queued frame is long before the frame binds — and
 *   at that moment the newest live frame is whichever *other* identity
 *   read is still in flight. Capturing there named a concurrent read's
 *   inner array as this read's "outer", and by the time this frame
 *   settled that array had already been forwarded and dropped, so these
 *   records reached no ledger at all. At bind time the frame ahead has
 *   settled and popped itself, so the newest live frame is the true
 *   enclosing one.
 * - On the isolating storage there is no queue, so bind time *is* call
 *   time and the capture is the same store either way. What would break
 *   is reading it from *inside* `fn`: `getStore()` there answers this
 *   frame's own state. Before `storage.run`, still in the caller's
 *   async context, is the only place both storages agree on.
 *
 * The forward is a copy, so the frame's own array (which the caller
 * reads its markers off) is untouched, and it runs on both outcomes:
 * a failed read still happened, and a line's byte accounting has to see
 * every op it paid for.
 */
function bindFrame<T>(state: RecordingState, fn: () => Promise<T>): Promise<T> {
  const outer = storage.getStore()?.records ?? null
  const forward = (): void => {
    if (outer !== null) outer.push(...state.records)
  }
  try {
    return Promise.resolve(storage.run(state, fn)).finally(forward)
  } catch (err) {
    forward()
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Run `fn` with `prefix` as the mount prefix records are named against.
 *
 * Derives a state for this async branch and shares only the records array,
 * so two mounts consumed concurrently (`cat /s3/a & cat /db/b`) cannot see
 * or clobber each other's prefix. Mirrors python's `push_mount_prefix`,
 * whose `Recorder` is frozen and re-set per task for the same reason.
 *
 * Inert (runs `fn` unchanged) when no recording context is active.
 */
export function runWithMountPrefix<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  const state = storage.getStore()
  if (state === undefined) return fn()
  return Promise.resolve(storage.run({ records: state.records, mountPrefix: prefix }, fn))
}

/**
 * Wrap a stream so `prefix` is the active mount prefix during each pull from
 * the underlying source. A command may return a stream that defers its
 * backend read to the first chunk request, by which point the mount's own
 * scope has already exited, so without this the record lands with no prefix.
 * Mirrors python's `with_mount_prefix`.
 */
export async function* withMountPrefix(
  prefix: string,
  it: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const iter = it[Symbol.asyncIterator]()
  try {
    for (;;) {
      const step = await runWithMountPrefix(prefix, () => iter.next())
      if (step.done === true) return
      yield step.value
    }
  } finally {
    await iter.return?.(undefined)
  }
}

// Whether a recording context is active. Backends that need an extra API
// call to capture fingerprint/revision metadata (Drive, Graph) gate it on
// this so unrecorded reads stay single-request.
export function recordingActive(): boolean {
  return storage.getStore() !== undefined
}

// The live array the active frame appends to, null when none is active.
// The twin of python's `active_recorder().sink`, and what a caller
// opening a nested frame needs on both ends of it: the frame's own
// records to read markers off, and the enclosing frame's array to hand
// them up to, so a line's byte accounting still sees every op that
// happened inside the nested one.
export function activeRecords(): OpRecord[] | null {
  return storage.getStore()?.records ?? null
}

export interface RecordOptions {
  fingerprint?: string | null
  revision?: string | null
}

export function record(
  op: string,
  path: string,
  source: string,
  nbytes: number,
  startMs: number,
  options: RecordOptions = {},
): void {
  const state = storage.getStore()
  if (state === undefined) return
  const elapsed = Math.floor(performance.now() - startMs)
  state.records.push(
    new OpRecord({
      op,
      path: applyPrefix(state.mountPrefix, path),
      source,
      bytes: nbytes,
      timestamp: Date.now(),
      durationMs: elapsed,
      fingerprint: options.fingerprint ?? null,
      revision: options.revision ?? null,
    }),
  )
}

export function recordStream(
  op: string,
  path: string,
  source: string,
  options: RecordOptions = {},
): OpRecord | null {
  const state = storage.getStore()
  if (state === undefined) return null
  const rec = new OpRecord({
    op,
    path: applyPrefix(state.mountPrefix, path),
    source,
    bytes: 0,
    timestamp: Date.now(),
    durationMs: 0,
    fingerprint: options.fingerprint ?? null,
    revision: options.revision ?? null,
  })
  state.records.push(rec)
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
  return Promise.resolve(revisionsStorage.run({ map: revisions }, fn))
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
  for (const state of revisionsStorage.liveStores()) {
    const pin = state.map?.get(path)
    if (pin !== undefined) return pin
  }
  return null
}

// Backends name the mount-relative path ('/report.json') and a few name the
// virtual one already ('/s3/report.json'), so tell them apart before
// prefixing. The test has to be for a path boundary, not a bare startsWith:
// a mount at /s3 holding s3-report.txt would otherwise look already-prefixed
// and record as '/s3-report.txt'. A mount-relative path spelled without its
// leading slash (the drive and box backends hand over
// `PathSpec.resourcePath`) gets the separator, because a plain concatenation
// names nothing: '/s3' and 'report.json' would record as '/s3report.json',
// which is not a path any caller can match, follow or grep for.
// Mirrors python's _virtual.
function applyPrefix(prefix: string, path: string): string {
  const root = rstripSlash(prefix)
  // A root mount's prefix is empty, so a slashless mount-relative
  // spelling (drive, graph, box hand these over) would pass through
  // unprefixed and no virtual-path lookup could match the record.
  if (root === '') return path.startsWith('/') ? path : `/${path}`
  if (path === root || path.startsWith(`${root}/`)) return path
  return path.startsWith('/') ? root + path : `${root}/${path}`
}
