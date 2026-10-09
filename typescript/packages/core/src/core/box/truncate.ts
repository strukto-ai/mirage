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

import { enotsup } from '../../errors/fs.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import { runWithOwnVersion, writesConditioned } from '../../cache/context.ts'
import { OwnRead } from '../../cache/types.ts'
import type { PathSpec } from '../../types.ts'
import { sha1Hex } from '../../utils/hash.ts'
import { downloadFile } from './api.ts'
import { liveOf } from './fingerprint.ts'
import { pathParts, resolveItem } from './resolve.ts'
import { write } from './write.ts'

export async function truncate(
  accessor: BoxAccessor,
  path: PathSpec,
  length: number,
  noCreate = false,
): Promise<void> {
  if (noCreate) throw enotsup('box', 'truncate --no-create', path)
  if (length === 0 && writesConditioned(path)) {
    // Emptying carries the agent's version; no read needed.
    await write(accessor, path, new Uint8Array(0))
    return
  }
  const item = await resolveItem(accessor, pathParts(path))
  const live = liveOf(item)
  let data: Uint8Array = new Uint8Array(0)
  let own: string | OwnRead | null = OwnRead.ABSENT
  if (item !== null && live !== null) {
    data = await downloadFile(accessor.tokenManager, item.id)
    own = live.content !== null ? await sha1Hex(data) : null
  }
  let next: Uint8Array
  if (length <= data.length) {
    next = data.slice(0, length)
  } else {
    next = new Uint8Array(length)
    next.set(data)
  }
  await runWithOwnVersion(path, own, () => write(accessor, path, next))
}
