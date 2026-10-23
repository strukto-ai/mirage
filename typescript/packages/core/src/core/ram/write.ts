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

import { activePipe } from '../dev/device.ts'
import { chunks } from '../../io/cooperative.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import { concat } from '../../utils/bytes.ts'
import { STREAM_PUBLISH_SECONDS } from './constants.ts'
import { record, startOp } from '../../observe/context.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { nowIso } from '../../utils/dates.ts'
import { norm } from '../../utils/path.ts'

import { checkDestParents, checkWriteTarget } from './dest.ts'

export async function write(
  accessor: RAMAccessor,
  path: PathSpec,
  data: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const timer = startOp()
  const p = norm(path.mountPath)
  const pipe = activePipe(accessor, p)
  if (pipe !== null) {
    await pipe.write(data, path, signal)
    record('write', path.virtual, VFSName.RAM, data.byteLength, timer)
    return
  }
  checkDestParents(accessor, path, p)
  checkWriteTarget(accessor, path, p)
  accessor.store.files.set(p, data)
  accessor.store.modified.set(p, nowIso())
  record('write', path.virtual, VFSName.RAM, data.byteLength, timer)
  return Promise.resolve()
}

/**
 * Write bytes as they arrive, so a reader watches the file grow. What has
 * arrived lands within `STREAM_PUBLISH_SECONDS`, a writer gone quiet
 * included, and at the end: a replacement at its own position, as an open
 * file's offset keeps it, an append at the file's end then, so another
 * appender's bytes stay. An append that brings nothing leaves an existing
 * file as it was (`true >> f`).
 * `atomic` stages the replacement until it ends. Mirrors Python's
 * `write_stream`.
 */
export async function writeStream(
  accessor: RAMAccessor,
  path: PathSpec,
  data: ByteSource,
  append = false,
  signal?: AbortSignal,
  atomic = false,
): Promise<void> {
  const timer = startOp()
  const p = norm(path.mountPath)
  const op = append ? 'append' : 'write'
  let size = 0
  const pipe = activePipe(accessor, p)
  if (pipe !== null) {
    for await (const chunk of chunks(data)) {
      await pipe.write(chunk, path, signal)
      size += chunk.byteLength
    }
    record(op, path.virtual, VFSName.RAM, size, timer)
    return
  }
  checkDestParents(accessor, path, p)
  checkWriteTarget(accessor, path, p)
  const { files, modified } = accessor.store
  if (atomic) {
    const whole = await materialize(data)
    files.set(p, whole)
    modified.set(p, nowIso())
    record(op, path.virtual, VFSName.RAM, whole.byteLength, timer)
    return
  }
  if (!append || !files.has(p)) {
    files.set(p, append ? (files.get(p) ?? new Uint8Array()) : new Uint8Array())
    modified.set(p, nowIso())
  }
  let pending: Uint8Array[] = []
  let position = 0
  let last = performance.now()
  let later: ReturnType<typeof setTimeout> | null = null
  const publish = (): void => {
    if (later !== null) clearTimeout(later)
    later = null
    last = performance.now()
    if (pending.length === 0) return
    const data = concat(pending)
    pending = []
    const current = files.get(p) ?? new Uint8Array()
    if (append) {
      files.set(p, concat([current, data]))
    } else {
      const next = new Uint8Array(Math.max(current.byteLength, position + data.byteLength))
      next.set(current)
      next.set(data, position)
      files.set(p, next)
      position += data.byteLength
    }
    modified.set(p, nowIso())
  }
  try {
    for await (const chunk of chunks(data)) {
      pending.push(chunk)
      size += chunk.byteLength
      const wait = STREAM_PUBLISH_SECONDS * 1000 - (performance.now() - last)
      if (wait <= 0) publish()
      else later ??= setTimeout(publish, wait)
    }
  } finally {
    publish()
  }
  record(op, path.virtual, VFSName.RAM, size, timer)
}
