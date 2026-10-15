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
import { type DirListing, type FileStat, FileType, type PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import type { Row } from '../vector/types.ts'
import { groupName, rowStem } from './naming.ts'
import { fieldValue } from './payload.ts'
import { renderJson, renderText } from './render.ts'
import { rstripSlash } from '../../utils/slash.ts'

type Readdir = (accessor: QdrantAccessor, path: PathSpec) => Promise<FileStat[] | DirListing>

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
 * The listing's scroll carries every payload, so each `.json` and `.txt` row
 * keeps its rendered text, lowercased, and a file is read only when that text
 * holds `text`; a blob, or a file too large to keep, is always read. The walk
 * lists each directory from the store, so the text is checked against the
 * points as they are now. null for a text that is not ASCII, whose case a
 * lowercased copy may not keep, or a listing that fails. Mirrors Python's
 * `files_containing`.
 */
export async function filesContaining(
  readdir: Readdir,
  accessor: QdrantAccessor,
  text: string,
  under: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  if (/[\u0080-\uffff]/.test(text)) return null
  try {
    return await found(readdir, accessor, text.toLowerCase(), under)
  } catch (err) {
    // the client rejects with a QdrantClient error, or the fetcher's error
    // with a status, when Qdrant refuses or times out, and fetch with a
    // TypeError when the connection fails
    const failed =
      err instanceof TypeError ||
      (err instanceof Error &&
        (err.name.startsWith('QdrantClient') ||
          typeof (err as { status?: unknown }).status === 'number'))
    if (!failed) throw err
    console.debug(`qdrant listing failed (${String(err)}); reading every file`)
    return null
  }
}

async function found(
  readdir: Readdir,
  accessor: QdrantAccessor,
  needle: string,
  under: readonly PathSpec[],
): Promise<PathSpec[]> {
  const out: PathSpec[] = []
  const pending = [...under]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const parent = rstripSlash(current.mountPath)
    for (const row of rowsOf(await readdir(accessor, current))) {
      const child = mountedPath(current, `${parent}/${row.name}`)
      if (row.type === FileType.DIRECTORY) {
        pending.push(child)
        continue
      }
      const kept = row.extra.text
      if (typeof kept === 'string' && !kept.includes(needle)) continue
      out.push(child)
    }
  }
  return out
}
