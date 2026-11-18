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
import { eisdir } from '../../errors/fs.ts'
import { memoryRoom } from '../../io/memory.ts'
import { recordStream } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { FLUSH_BYTES, READ_BYTES } from './constants.ts'
import { readBytes } from './data.ts'
import { isDir } from './inode.ts'
import { found, walk } from './path.ts'

/** Stream smaller pages on tight heaps and amortize remote SQL calls on larger ones. */
export async function* readStream(
  accessor: SqlAccessor,
  path: PathSpec,
): AsyncIterable<Uint8Array> {
  const node = found(await walk(accessor, path), path)
  if (isDir(node)) throw eisdir(path)
  const rec = recordStream('read', path.virtual, VFSName.SQL)
  const room = memoryRoom()
  const window = room !== null && room <= 32 * FLUSH_BYTES ? READ_BYTES : FLUSH_BYTES
  const cs = await accessor.chunkSize()
  let offset = 0
  while (offset < node.size) {
    const length = cs > window ? Math.min(window, cs - (offset % cs)) : window
    const data = await readBytes(accessor, node, offset, length)
    offset += data.byteLength
    if (rec !== null) rec.bytes += data.byteLength
    yield data
  }
  if (rec !== null) rec.complete = true
}
