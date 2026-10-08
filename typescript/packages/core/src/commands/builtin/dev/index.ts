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

import type { Accessor } from '../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { ZERO_CHUNK_SIZE } from '../../../core/dev/constants.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import type { Command, CommandIO } from '../../config.ts'
import { genericCommands } from '../generic_bind/index.ts'

type ReadRange = NonNullable<CommandIO['readRange']>

/**
 * Stream `path` as successive ranged reads at the door. `/dev/zero` answers
 * every range in full, so the stream ends only when the reader stops;
 * `/dev/null` and a regular file end at the first short range. Each range
 * is a door read, so hides, path rules and policies judge it. Mirrors
 * Python's `_ranged`.
 */
async function* ranged(
  readRange: ReadRange,
  accessor: Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  let offset = 0
  for (;;) {
    const chunk = await readRange(accessor, path, index, offset, ZERO_CHUNK_SIZE)
    if (chunk.byteLength > 0) yield chunk
    if (chunk.byteLength < ZERO_CHUNK_SIZE) return
    offset += chunk.byteLength
  }
}

function endless(io: CommandIO): CommandIO {
  const readRange = io.readRange
  if (readRange === undefined) return io
  return { ...io, readStream: (accessor, path, index) => ranged(readRange, accessor, path, index) }
}

// /dev is a RAM mount whose read and stat know the two synthetic character
// devices. Commands that consume a whole input read a finite stream, while
// the two bounded streaming commands read in ranges, which /dev/zero answers
// without end.
export const DEV_COMMANDS: readonly Command[] = [
  ...genericCommands(VFSName.RAM, { adapt: { cat: endless, head: endless }, local: true }),
]
