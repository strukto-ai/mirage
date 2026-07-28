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

/**
 * Set the mount prefix records are named against, returning the prefix that
 * was active before. Callers restore that value rather than clearing to '',
 * so a mount whose command dispatches into another mount gets its own prefix
 * back. Mirrors python's `push_mount_prefix`.
 *
 * No-op (and returns '') when no recording context is active.
 */
export function pushMountPrefix(prefix: string): string {
  const state = storage.getStore()
  if (state === undefined) return ''
  const prev = state.mountPrefix
  state.mountPrefix = prefix
  return prev
}

/**
 * Wrap a stream so `prefix` is the active mount prefix during each pull from
 * the underlying source. A command may return a stream that defers its
 * backend read to the first chunk request, by which point the mount's own
 * push/restore pair has already run, so without this the record lands with no
 * prefix. Mirrors python's `with_mount_prefix`.
 */
export async function* withMountPrefix(
  prefix: string,
  it: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const iter = it[Symbol.asyncIterator]()
  try {
    for (;;) {
      const prev = pushMountPrefix(prefix)
      let step: IteratorResult<Uint8Array>
      try {
        step = await iter.next()
      } finally {
        pushMountPrefix(prev)
      }
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
 */
export function revisionFor(path: string): string | null {
  const map = revisionsStorage.getStore()?.map
  if (!map) return null
  return map.get(path) ?? null
}

function applyPrefix(prefix: string, path: string): string {
  if (prefix !== '' && !path.startsWith(prefix)) {
    return rstripSlash(prefix) + path
  }
  return path
}
