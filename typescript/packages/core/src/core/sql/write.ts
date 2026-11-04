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

import type { SqlAccessor } from '../../accessor/sql.ts'
import { chunks } from '../../io/cooperative.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'
import { FILE_MODE } from '../../utils/stat_view.ts'
import type { SqlStatement } from '../../vfs/sql/types.ts'
import { FLUSH_BYTES } from './constants.ts'
import { placeBytes } from './data.ts'
import { byEntry, byIno, makeNode, nowStamp, resized, type Inode } from './inode.ts'
import {
  checkDestParents,
  checkWriteTarget,
  found,
  leaf,
  parentRef,
  target,
  walk,
  type Walk,
} from './path.ts'

// The statements that land `data` whole: a new file made with it, an existing
// one's rows replaced, or `data` added at its end.
async function landing(
  accessor: SqlAccessor,
  w: Walk,
  node: Inode | null,
  data: Uint8Array,
  append: boolean,
): Promise<SqlStatement[]> {
  const now = nowStamp()
  if (node === null) {
    const ref = byEntry(parentRef(w), leaf(w))
    return [
      ...makeNode(accessor, parentRef(w), leaf(w), FILE_MODE, data.byteLength, now),
      ...(await placeBytes(accessor, ref, null, 0, data)),
    ]
  }
  const ino = byIno(node.ino)
  if (append) {
    return [
      ...(await placeBytes(accessor, ino, node, node.size, data)),
      resized(ino, node.size + data.byteLength, now),
    ]
  }
  return [
    { sql: `DELETE FROM fs_data WHERE ino = ${ino.sql}` },
    ...(await placeBytes(accessor, ino, null, 0, data)),
    resized(ino, data.byteLength, now),
  ]
}

/**
 * Replace a file's bytes, or add them to its end. Bytes land in one
 * transaction, as does a stream under `atomic`, staged until it ends. Any
 * other stream lands `FLUSH_BYTES` at a time, so a reader watches the file
 * grow: a replacement empties the file first and writes at its own position,
 * an append writes past the file's end. An append that brings nothing leaves
 * an existing file as it was (`true >> f`). Mirrors Python's `write`.
 */
export async function write(
  accessor: SqlAccessor,
  path: PathSpec,
  data: ByteSource,
  append = false,
  atomic = false,
): Promise<void> {
  const timer = startOp()
  const w = await walk(accessor, path)
  checkDestParents(w, path)
  checkWriteTarget(w, path)
  const op = append ? 'append' : 'write'
  const existing = target(w)
  if (data instanceof Uint8Array || atomic) {
    const whole = await materialize(data)
    if (append && whole.byteLength === 0 && existing !== null) return
    await accessor.batch(await landing(accessor, w, existing, whole, append))
    record(op, path.virtual, VFSName.SQL, whole.byteLength, timer)
    return
  }
  if (existing === null || !append) {
    await accessor.batch(await landing(accessor, w, existing, new Uint8Array(0), false))
  }
  let node = found(await walk(accessor, path), path)
  let offset = append ? node.size : 0
  let pending: Uint8Array[] = []
  let held = 0
  let written = 0
  const flush = async (): Promise<void> => {
    if (held === 0) return
    const block = concat(pending)
    const ino = byIno(node.ino)
    const size = Math.max(node.size, offset + block.byteLength)
    await accessor.batch([
      ...(await placeBytes(accessor, ino, node, offset, block)),
      resized(ino, size, nowStamp()),
    ])
    node = { ...node, size }
    offset += block.byteLength
    written += block.byteLength
    pending = []
    held = 0
  }
  for await (const chunk of chunks(data)) {
    if (chunk.byteLength === 0) continue
    pending.push(chunk)
    held += chunk.byteLength
    if (held >= FLUSH_BYTES) await flush()
  }
  await flush()
  record(op, path.virtual, VFSName.SQL, written, timer)
}
