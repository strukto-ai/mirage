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

import { activeDevice, activePipe } from '../dev/device.ts'
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

/**
 * Replace a file's bytes, or add them to its end. Bytes land at once, as does
 * a stream under `atomic`, staged until it ends. Any other stream lands as it
 * arrives, so a reader watches the file grow: what has arrived lands within
 * `STREAM_PUBLISH_SECONDS`, a writer gone quiet included, and at the end, a
 * replacement at its own position, as an open file's offset keeps it, an
 * append at the file's end then, so another appender's bytes stay. Appending
 * nothing opens the file (`true >> f`): it creates a missing one and leaves an
 * existing one as it was, modification time included. A device that discards
 * writes (`/dev/null`) has its bytes counted as they arrive and kept nowhere.
 * Mirrors Python's `write`.
 */
export async function write(
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
    if (data instanceof Uint8Array) {
      await pipe.write(data, path, signal)
      size = data.byteLength
    } else {
      for await (const chunk of chunks(data)) {
        await pipe.write(chunk, path, signal)
        size += chunk.byteLength
      }
    }
    record(op, path.virtual, VFSName.RAM, size, timer)
    return
  }
  checkDestParents(accessor, path, p)
  checkWriteTarget(accessor, path, p)
  const { files, modified } = accessor.store
  if (activeDevice(accessor, p) !== null) {
    if (data instanceof Uint8Array) size = data.byteLength
    else for await (const chunk of chunks(data)) size += chunk.byteLength
    if (size > 0 || !append) modified.set(p, nowIso())
    record(op, path.virtual, VFSName.RAM, size, timer)
    return
  }
  if (data instanceof Uint8Array || atomic) {
    const whole = data instanceof Uint8Array ? data : await materialize(data)
    const current = append ? files.get(p) : undefined
    if (current !== undefined && whole.byteLength === 0) return
    files.set(p, current === undefined ? whole : concat([current, whole]))
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
