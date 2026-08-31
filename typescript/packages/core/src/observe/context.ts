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
 * How long a queued frame waits for the one ahead of it before giving
 * up on having a frame at all.
 *
 * The queue below cannot tell a genuinely concurrent caller from a
 * caller that re-entered from inside the frame it is queued behind, and
 * on the fallback storage nothing at the call site can: the ambient
 * store is the live frame either way, so a discriminator that let the
 * re-entrant one through would let a concurrent one through with it and
 * un-fix the interleaving the queue exists for. So the wait is bounded
 * instead of decided. A caller that waits this long runs anyway, at the
 * cost described in {@link runRecorded}; a concurrent one never reaches
 * the bound, because it was always going to be released by the frame
 * ahead settling long before this.
 *
 * Two seconds is chosen to sit far above any backend read a frame ahead
 * is plausibly still waiting on and far below a caller's patience for a
 * hang.
 */
export const RECORDED_BIND_TIMEOUT_MS = 2000

/**
 * Wait for `tail`, but not forever, then run — bound if the tail
 * released this frame, frameless if the bound lapsed first.
 *
 * The race is decided by the winner's own tag rather than by a flag the
 * loser could also have set, so a tail settling in the same tick as the
 * timer is still an ordinary release. The timer is cleared as soon as
 * the tail wins, so a queue that is merely busy holds nothing open
 * beyond the wait its caller is already doing. It is deliberately not
 * `unref`'d: the whole point is that this frame still runs when the
 * tail never settles, and an unreferenced timer would let the runtime
 * exit that window instead of serving it.
 *
 * On a lapse `fn` runs with no frame of its own — no `storage.run`, no
 * outer capture, no forward, and `state` left as the empty array its
 * caller already holds. See {@link runRecorded} for why not binding is
 * the whole point.
 */
function runAfter<T>(tail: Promise<void>, state: RecordingState, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const lapsed = new Promise<'lapsed'>((resolve) => {
    timer = setTimeout(() => {
      resolve('lapsed')
    }, RECORDED_BIND_TIMEOUT_MS)
  })
  const released = tail.then((): 'released' => 'released')
  return Promise.race([released, lapsed]).then((winner) => {
    if (timer !== undefined) clearTimeout(timer)
    return winner === 'released' ? bindFrame(state, fn) : fn()
  })
}

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
 * One constraint follows from the queue, and it belongs in the same
 * family as the FUSE rule about never touching your own mountpoint from
 * the process serving it: **on a fallback runtime, code servicing a read
 * must not re-enter the identity surface.** A frame that opens another
 * one inside itself is waiting for its own settle, which is a promise
 * cycle and not a slow path. The single in-repo caller
 * ({@link Ops.readFileWithIdentity}) does not nest, but an embedder's
 * custom read op or an ops policy closing over the workspace can reach
 * it, so the wait is bounded ({@link RECORDED_BIND_TIMEOUT_MS}) rather
 * than trusted.
 *
 * **A lapse runs the queued frame frameless; it does not bind it.**
 * That is the whole of the bound's design, because binding is not free
 * on this storage: the newest frame is what `getStore()` answers, so a
 * frame bound over a read that is merely *slow* takes every record that
 * read emits after its next await, and the slow read — the one that was
 * already running, and has already paid for its backend call — comes
 * back with no identity at all. The frame that waited is the one whose
 * wait ran out, so the frame that waited is what a lapse costs: `fn`
 * runs with no frame, its records array stays empty, and it answers a
 * null identity, which is the marker-less shape every consumer already
 * hashes through. The in-flight read keeps every record and its
 * identity. The re-entrant case is the same trade with a better ending
 * than the deadlock it replaces: the nested call completes, and the
 * frame it re-entered from keeps its own records instead of losing them
 * to its own nested call. The tail still settles either way, so the
 * frames behind it are released on schedule.
 *
 * A frameless run's own records land in whatever frame is ambient,
 * which here is that in-flight read's array. {@link readIdentity}
 * filters by path, so all it can contribute is a foreign-path record
 * the read discards — except for a record naming the *same* path, and
 * there the scan order is load-bearing: newest-first answers with the
 * marked record the frame emitted **last**, and a frameless run only
 * gets to interleave while the read ahead is still waiting on its
 * backend, which is strictly before that read stamps its own markers.
 * Reverse that scan and the slow read starts answering with the
 * late-comer's marker instead of its own. This is also why the rule
 * above is "do not re-enter" rather than "re-entry is free": a
 * re-entrant call naming the same path is the one shape neither the
 * filter nor the ordering separates, and it is unbounded recursion on
 * its own terms anyway.
 *
 * The frameless run's mount prefix rides along the same way — a
 * {@link runWithMountPrefix} inside it derives from the ambient frame,
 * so a record the read in flight emits during that scope is named
 * against the wrong mount. That costs the read its own filter match, so
 * it lands on the same safe side: missing, not someone else's.
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
  const ahead = recordedTail
  const done: Promise<T> = ahead === null ? bindFrame(state, fn) : runAfter(ahead, state, fn)
  // The queue only sequences; `done` is what carries the outcome to the
  // caller, so the tail settles on either path rather than rejecting
  // with nobody left to hear it. It is cleared when this frame is the
  // last one out, so the next caller binds synchronously again.
  //
  // The tail waits for the frame ahead as well as for this one. On a
  // normal release that costs nothing -- this frame could not have
  // started before that one settled -- and after a lapse it is the
  // whole point: a frameless run finishing says nothing about the read
  // it ran alongside, so publishing its settle alone would tell the
  // next caller the queue is idle and let it bind over a read still in
  // flight, which is exactly the theft the lapse declined to commit.
  const own = done.then(
    () => undefined,
    () => undefined,
  )
  const tail = ahead === null ? own : Promise.all([own, ahead]).then(() => undefined)
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
