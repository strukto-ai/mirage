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

import { ZERO_CHUNK_SIZE } from '../../../core/dev/constants.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import type { Files } from '../../../workspace/files.ts'
import type { Command, Context } from '../../config.ts'
import { genericReading } from '../generic_bind/factory.ts'

/**
 * Stream `path` as successive ranged reads of the stored bytes. `/dev/zero`
 * answers every range in full, so the stream ends only when the reader
 * stops; `/dev/null` and a regular file end at the first short range. Each
 * range is a dispatcher read, so hides, path rules and policies judge it.
 * Mirrors Python's `_ranged`.
 */
async function* ranged(files: Files, path: PathSpec): AsyncIterable<Uint8Array> {
  let offset = 0
  for (;;) {
    const chunk = await files.read(path, { raw: true, offset, size: ZERO_CHUNK_SIZE })
    if (chunk.byteLength > 0) yield chunk
    if (chunk.byteLength < ZERO_CHUNK_SIZE) return
    offset += chunk.byteLength
  }
}

// An operand read in ranges, except a descriptor under `/fd/`, which keeps
// the dispatched stream. Mirrors Python's `_endless`.
function endless(ctx: Context, path: PathSpec): AsyncIterable<Uint8Array> | null {
  if (ctx.vfs === undefined || path.mountPath.startsWith('/fd/')) return null
  return ranged(ctx.vfs, path)
}

// /dev is a RAM mount whose read and stat know the two synthetic character
// devices. Commands that consume a whole input read a finite stream, while
// the two bounded streaming commands read in ranges, which /dev/zero answers
// without end.
export const DEV_COMMANDS: readonly Command[] = [
  genericReading('cat', { vfs: VFSName.RAM, stream: endless }),
  genericReading('head', { vfs: VFSName.RAM, stream: endless }),
]
