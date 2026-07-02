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

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import type { LanceRow } from './_driver.ts'
import type { LanceDBConfigResolved } from '../../resource/lancedb/config.ts'
import type { PathSpec } from '../../types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { renderCard } from './render.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function toStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as string | number | boolean | bigint)
}

function targetTable(paths: PathSpec[], config: LanceDBConfigResolved): string | null {
  if (config.table !== null) return config.table
  for (const path of paths) {
    const key = stripSlash(path.mountPath)
    if (key !== '') return key.split('/')[0] ?? null
  }
  return null
}

function canonicalPath(
  row: LanceRow,
  config: LanceDBConfigResolved,
  table: string,
  mountPrefix: string,
): string {
  const segs: string[] = []
  if (config.table === null) segs.push(table)
  for (const column of config.groupBy) {
    const value = row[column]
    if (value !== null && value !== undefined) segs.push(toStr(value))
  }
  segs.push(`${toStr(row[config.idColumn])}.md`)
  const prefix = rstripSlash(mountPrefix)
  return `${prefix}/${segs.join('/')}`
}

function block(
  row: LanceRow,
  config: LanceDBConfigResolved,
  table: string,
  mountPrefix: string,
): string {
  const path = canonicalPath(row, config, table, mountPrefix)
  const distance = row._distance
  const header =
    distance === null || distance === undefined ? path : `${path}:${Number(distance).toFixed(4)}`
  const bodyRow: LanceRow = { ...row }
  delete bodyRow._distance
  const content = DEC.decode(renderCard(bodyRow, config)).replace(/\n+$/, '')
  return `${header}\n${content}`
}

export async function searchRowsOutput(
  accessor: LanceDBAccessor,
  query: string,
  paths: PathSpec[],
  topK: number,
  threshold: number,
  mountPrefix: string,
): Promise<Uint8Array> {
  if (query === '') throw new Error('search: query is required')
  if (topK <= 0) throw new Error('search: top-k must be positive')
  const table = targetTable(paths, accessor.config)
  if (table === null) throw new Error('search: no table to search')
  const rows = await accessor.searchRows(table, query, topK)
  const blocks: string[] = []
  for (const row of rows) {
    const distance = row._distance
    if (
      threshold > 0 &&
      distance !== null &&
      distance !== undefined &&
      Number(distance) > threshold
    ) {
      continue
    }
    blocks.push(block(row, accessor.config, table, mountPrefix))
  }
  if (blocks.length === 0) return new Uint8Array()
  return ENC.encode(blocks.join('\n') + '\n')
}
