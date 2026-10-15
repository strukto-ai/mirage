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
import { writesConditioned } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { getFileInfo } from './api.ts'
import { SHA1 } from './constants.ts'
import { readToken, tokenOf } from './fingerprint.ts'
import { fileEntry } from './read.ts'

/**
 * The sha1 Box keeps for a file's content, asked live: a listing row's sha1
 * can be older than the bytes a read downloads, so the file's own record is
 * asked. Box keeps no other digest. A digest answered is recorded as the read
 * it stands in for, with the token a whole read of those bytes would record.
 * Mirrors Python's core/box/checksum.py.
 */
export async function checksum(
  accessor: BoxAccessor,
  path: PathSpec,
  algorithm: string,
  entry?: FileStat | null,
): Promise<string | null> {
  if (algorithm !== SHA1) return null
  const row = fileEntry(path, entry)
  const timer = startOp()
  const item = await getFileInfo(accessor.tokenManager, row.extra.box_id as string)
  const found = tokenOf(item.sha1)
  if (found === null) return null
  const digest = found.toLowerCase()
  record('read', path.virtual, 'box', 0, timer, {
    fingerprint: writesConditioned(path) ? digest : readToken(row, digest),
  })
  return digest
}
