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

import { createAsyncContext } from '../utils/async_context.ts'
import { OpRecord } from './record.ts'
import { uuid7 } from '../utils/ids.ts'
import { rstripSlash } from '../utils/slash.ts'

interface RecordingState {
  records: OpRecord[]
  mountPrefix: string
  /**
   * Identifier of the typed line being recorded, stamped onto every
   * record so the ops and the command event share a key.
   */
  lineId: string
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

export async function runWithRecording<T>(fn: () => Promise<T>): Promise<[T, OpRecord[], string]> {
  const state: RecordingState = { records: [], mountPrefix: '', lineId: uuid7() }
  const value = await storage.run(state, fn)
  return [value, state.records, state.lineId]
}

/**
 * The line id of the active recording scope, or null outside one.
 * The ops facade reads it so a call raised by guest code inside a typed
 * line (the runtime's patched open()) is attributed to that line, while
 * one raised by a FUSE callback belongs to no line and carries none.
 */
export function activeLineId(): string | null {
  return storage.getStore()?.lineId ?? null
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
  return Promise.resolve(
    storage.run({ records: state.records, mountPrefix: prefix, lineId: state.lineId }, fn),
  )
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
      lineId: state.lineId === '' ? null : state.lineId,
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
    lineId: state.lineId === '' ? null : state.lineId,
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
// and record as '/s3-report.txt'. Mirrors python's _virtual.
function applyPrefix(prefix: string, path: string): string {
  const root = rstripSlash(prefix)
  if (root === '' || path === root || path.startsWith(`${root}/`)) return path
  return root + path
}
