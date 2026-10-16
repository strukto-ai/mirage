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

import { record, startOp } from '@struktoai/mirage-core/observe/context'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { refusalsDenied } from './lookup.ts'
import { resolveEntry, rowToken } from './read.ts'
import { fetchPath } from './tree.ts'

export const LFS_OID = /^[0-9a-f]{64}$/

/**
 * The sha256 the Hub keeps for an LFS file, asked live.
 *
 * An LFS file's row carries its LFS oid, the sha256 of exactly the bytes a
 * read downloads. A plain git blob's oid hashes a git header with the bytes,
 * and the Hub keeps no other digest, so every other file and algorithm is
 * read, without a request when the listing's row names no LFS oid. The
 * listing's row can be older than the bytes a read downloads, so an LFS file's
 * row is asked again with one paths-info request, the row a tree walk carries.
 * A digest answered is recorded as the read it stands in for, with the token a
 * read of those bytes would record. Mirrors Python's `checksum`.
 */
export async function checksum(
  accessor: HfHubAccessor,
  path: PathSpec,
  algorithm: string,
  entry?: FileStat | null,
): Promise<string | null> {
  if (algorithm !== 'sha256') return null
  const listed = resolveEntry(path, entry)
  const lfs = listed.extra.lfs_oid
  if (typeof lfs !== 'string' || lfs === '') return null
  const rel = stripSlash(path.mountPath)
  const timer = startOp()
  const found = (await refusalsDenied(path, () => fetchPath(accessor, rel))).get(rel)
  if (found === undefined || !LFS_OID.test(found.lfsOid)) return null
  record('read', path.virtual, accessor.vfsName, 0, timer, {
    fingerprint: rowToken(listed, found.lfsOid),
  })
  return found.lfsOid
}
