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

import type { QdrantConfigResolved } from '../../vfs/qdrant/config.ts'
import { md5Hex } from '../../utils/hash.ts'
import { fitIdName, parseIdName } from '../../utils/naming.ts'
import { NAME_MAX_BYTES, byteLength, pathSafeName } from '../../utils/sanitize.ts'
import { PATH_SAFE } from '../hierarchy/codec.ts'
import { valueText } from '../render/json.ts'
import type { QdrantRow } from './client.ts'
import { fieldValue } from './payload.ts'

const UTF8 = new TextEncoder()

/**
 * Render one payload value as a VFS directory segment.
 *
 * A non-string value spells the way the point's `.json` spells it, so
 * TypeScript and Python render one tree. Every level then renders through
 * `PATH_SAFE`, so the scope table decodes a segment back to the exact value it
 * stands for. A basename level first drops the value's URL or path parents,
 * which is lossy, so the lister resolves such a segment against the payload
 * instead of decoding it. A leaf longer than NAME_MAX, which ext4 and APFS
 * refuse, is cut to fit and keeps the md5 of the whole segment as its id,
 * the `<label>__<id>` shape every long name takes, so two leaves the cut
 * would merge stay two directories.
 */
export function groupName(value: unknown, basename = false): string {
  const name = valueText(value)
  if (!basename) return PATH_SAFE.encode(name)
  const withoutFragment = name.split('#', 1)[0] ?? name
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment
  const trimmed = withoutQuery.replace(/[\\/]+$/, '')
  const parts = trimmed.replace(/\\/g, '/').split('/')
  const leaf = parts[parts.length - 1] ?? ''
  const segment = PATH_SAFE.encode(leaf === '' ? name : leaf)
  if (byteLength(segment) <= NAME_MAX_BYTES) return segment
  return fitIdName(segment, md5Hex(UTF8.encode(segment)))
}

/** Return the stable, human-readable stem for a point's files. */
export function rowStem(row: QdrantRow, config: QdrantConfigResolved): string {
  // The point id is synthetic rather than payload data: pointToRow stores it
  // under the configured key verbatim, even when that key contains dots.
  const pointId = String(row[config.idField] as string | number | bigint | boolean)
  const label = fieldValue(row, config.nameField)
  if (label === undefined || label === null) return pointId
  const suffixes = ['.json']
  if (config.textField !== null && config.textField !== '') suffixes.push('.txt')
  if (config.blobField !== null && config.blobField !== '') suffixes.push(`.${config.blobExt}`)
  const longestSuffix = suffixes.reduce((a, b) => (byteLength(a) >= byteLength(b) ? a : b))
  const fitted = fitIdName(pathSafeName(valueText(label)), pointId, longestSuffix)
  return fitted.slice(0, -longestSuffix.length)
}

/** Recover the opaque Qdrant point id from a VFS file stem. */
export function pointIdFromStem(stem: string, config: QdrantConfigResolved): string {
  if (config.nameField === null || config.nameField === '') return stem
  try {
    return parseIdName(stem)[1]
  } catch {
    // A point missing the optional naming payload still lists by id.
    return stem
  }
}
