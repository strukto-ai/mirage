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
import type { QdrantRow } from './_client.ts'
import type { QdrantConfigResolved } from '../../resource/qdrant/config.ts'
import type { PathSpec } from '../../types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { renderJson, renderText } from './render.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function toStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as string | number | boolean | bigint)
}

function contentExt(row: QdrantRow, config: QdrantConfigResolved): string {
  if (
    config.textField !== null &&
    row[config.textField] !== null &&
    row[config.textField] !== undefined
  ) {
    return 'txt'
  }
  return 'json'
}

function targetTable(paths: PathSpec[], config: QdrantConfigResolved): string | null {
  if (config.collection !== null) return config.collection
  for (const path of paths) {
    const key = stripSlash(path.stripPrefix)
    if (key !== '') return key.split('/')[0] ?? null
  }
  return null
}

function canonicalPath(
  row: QdrantRow,
  config: QdrantConfigResolved,
  table: string,
  mountPrefix: string,
): string {
  const segs: string[] = []
  if (config.collection === null) segs.push(table)
  for (const column of config.groupBy) {
    const value = row[column]
    if (value !== null && value !== undefined) segs.push(toStr(value))
  }
  segs.push(`${toStr(row[config.idField])}.${contentExt(row, config)}`)
  const prefix = rstripSlash(mountPrefix)
  return `${prefix}/${segs.join('/')}`
}

function block(
  row: QdrantRow,
  config: QdrantConfigResolved,
  table: string,
  mountPrefix: string,
): string {
  const path = canonicalPath(row, config, table, mountPrefix)
  const score = row._score
  const header =
    score === null || score === undefined ? path : `${path}:${Number(score).toFixed(4)}`
  const bodyRow: QdrantRow = { ...row }
  delete bodyRow._score
  const rendered =
    contentExt(bodyRow, config) === 'txt'
      ? renderText(bodyRow, config)
      : renderJson(bodyRow, config)
  const content = DEC.decode(rendered).replace(/\n+$/, '')
  return `${header}\n${content}`
}

export async function searchRowsOutput(
  accessor: QdrantAccessor,
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
    const score = row._score
    if (threshold > 0 && score !== null && score !== undefined && Number(score) < threshold) {
      continue
    }
    blocks.push(block(row, accessor.config, table, mountPrefix))
  }
  if (blocks.length === 0) return new Uint8Array()
  return ENC.encode(blocks.join('\n') + '\n')
}
