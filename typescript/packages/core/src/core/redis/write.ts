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

import { record, startOp } from '../../observe/context.ts'
import { chunks } from '../../io/cooperative.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import { VFSName } from '../../types.ts'
import type { PathSpec } from '../../types.ts'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { checkDestParents, checkWriteTarget } from './dest.ts'
import { nowIso } from '../../utils/dates.ts'
import { norm } from '../../utils/path.ts'

/**
 * Replace a file's bytes, or add them to its end. Bytes land at once, as does
 * a stream under `atomic`, staged until it ends. Any other stream lands as it
 * arrives, so a reader watches the file grow: a replacement at its own
 * position (`SETRANGE`), as an open file's offset keeps it. An append goes at
 * the file's end (`APPEND`, which also creates a missing one), so another
 * appender's bytes stay, and one that brings nothing leaves an existing file
 * as it was (`true >> f`). Mirrors Python's `write`.
 */
export async function write(
  accessor: RedisAccessor,
  path: PathSpec,
  data: ByteSource,
  append = false,
  atomic = false,
): Promise<void> {
  const timer = startOp()
  const p = norm(path.mountPath)
  const store = accessor.store
  await checkDestParents(store, path, p)
  await checkWriteTarget(store, path, p)
  const op = append ? 'append' : 'write'
  if (data instanceof Uint8Array || atomic) {
    const whole = await materialize(data)
    if (!append) await store.setFile(p, whole)
    else if (whole.byteLength > 0 || !(await store.hasFile(p))) await store.appendFile(p, whole)
    else return
    await store.setModified(p, nowIso())
    record(op, path.virtual, VFSName.REDIS, whole.byteLength, timer)
    return
  }
  if (!append) {
    await store.setFile(p, new Uint8Array())
    await store.setModified(p, nowIso())
  } else if (!(await store.hasFile(p))) {
    await store.appendFile(p, new Uint8Array())
    await store.setModified(p, nowIso())
  }
  let size = 0
  for await (const chunk of chunks(data)) {
    if (chunk.byteLength === 0) continue
    if (append) await store.appendFile(p, chunk)
    else await store.setFileRange(p, size, chunk)
    await store.setModified(p, nowIso())
    size += chunk.byteLength
  }
  record(op, path.virtual, VFSName.REDIS, size, timer)
}
