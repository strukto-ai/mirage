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
import type { ByteSource } from '../../io/types.ts'
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
 * included, and at the end, appended to what the file holds then, so
 * another appender's bytes stay.
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
  if (!append && !atomic) {
    files.set(p, new Uint8Array())
    modified.set(p, nowIso())
  }
  let pending: Uint8Array[] = []
  let last = performance.now()
  let later: ReturnType<typeof setTimeout> | null = null
  const publish = (): void => {
    if (later !== null) clearTimeout(later)
    later = null
    const base = append || !atomic ? (files.get(p) ?? new Uint8Array()) : new Uint8Array()
    files.set(p, concat([base, ...pending]))
    modified.set(p, nowIso())
    pending = []
    last = performance.now()
  }
  try {
    for await (const chunk of chunks(data)) {
      pending.push(chunk)
      size += chunk.byteLength
      if (atomic) continue
      const wait = STREAM_PUBLISH_SECONDS * 1000 - (performance.now() - last)
      if (wait <= 0) publish()
      else later ??= setTimeout(publish, wait)
    }
  } finally {
    if (!atomic) publish()
  }
  if (atomic) publish()
  record(op, path.virtual, VFSName.RAM, size, timer)
}
