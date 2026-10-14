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

import type { BoxAccessor } from '../../accessor/box.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { getFileInfo } from './api.ts'
import { SHA1 } from './constants.ts'
import { tokenOf } from './fingerprint.ts'
import { fileEntry } from './read.ts'

/**
 * The sha1 Box keeps for a file's content, asked live: a listing row's sha1
 * can be older than the bytes a read downloads, so the file's own record is
 * asked. Box keeps no other digest. Mirrors Python's core/box/checksum.py.
 */
export async function checksum(
  accessor: BoxAccessor,
  path: PathSpec,
  algorithm: string,
  index?: IndexCacheStore,
): Promise<string | null> {
  if (algorithm !== SHA1) return null
  const entry = await fileEntry(accessor, path, index)
  const item = await getFileInfo(accessor.tokenManager, entry.id)
  const found = tokenOf(item.sha1)
  return found !== null ? found.toLowerCase() : null
}
