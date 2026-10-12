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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { type ReaddirFn, resolveEntry } from '../hierarchy/probe.ts'
import type { Row } from '../vector/types.ts'
import { groupName, rowStem } from './naming.ts'
import { fieldValue } from './payload.ts'
import { renderJson, renderText } from './render.ts'
import { rstripSlash } from '../../utils/slash.ts'

// The files a listing renders from a point's payload, whose entries keep their
// text; a blob is read as usual.
export const ROW_FILES: ReadonlySet<string> = new Set(['qdrant/row_json', 'qdrant/row_text'])

/**
 * A ranked point's path below its collection, and its body: the source text
 * when the point has one, its `.json` otherwise.
 */
export function hit(accessor: QdrantAccessor, row: Row): [string[], Uint8Array] {
  const config = accessor.config
  const segments: string[] = []
  for (const column of config.groupBy) {
    const value = fieldValue(row, column)
    if (value !== null && value !== undefined) {
      segments.push(groupName(value, config.basenameFields.includes(column)))
    }
  }
  const stem = rowStem(row, config)
  const text = config.textField !== null ? fieldValue(row, config.textField) : null
  if (text !== null && text !== undefined) {
    return [[...segments, `${stem}.txt`], renderText(row, config)]
  }
  return [[...segments, `${stem}.json`], renderJson(row, config)]
}

/**
 * The files under `under` that may hold `text` in any case.
 *
 * The listing's scroll carries every payload, so each `.json` and `.txt` entry
 * keeps its rendered text, lowercased, and a file is read only when that text
 * holds `text`; a blob, or a file too large to keep, is always read. Qdrant is
 * asked nothing more. null for a text that is not ASCII, whose case a
 * lowercased copy may not keep. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  readdir: ReaddirFn<QdrantAccessor>,
  accessor: QdrantAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  if (/[\u0080-\uffff]/.test(text)) return null
  const needle = text.toLowerCase()
  const found: PathSpec[] = []
  const pending = [...under]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const parent = rstripSlash(current.mountPath)
    for (const listed of await readdir(accessor, current, index)) {
      const child = mountedPath(current, `${parent}/${listed.slice(listed.lastIndexOf('/') + 1)}`)
      const entry = await resolveEntry(readdir, accessor, child, index)
      if (entry === null) return null
      const keptText = entry.extra.text
      if (entry.resourceType.endsWith('/group')) pending.push(child)
      else if (
        !ROW_FILES.has(entry.resourceType) ||
        typeof keptText !== 'string' ||
        keptText.includes(needle)
      ) {
        found.push(child)
      }
    }
  }
  return found
}
