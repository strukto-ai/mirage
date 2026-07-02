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

import type { LanceDBConfigResolved } from '../../resource/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'

export const ScopeLevel = Object.freeze({
  ROOT: 'root',
  GROUP_DIR: 'group_dir',
  ROW: 'row',
  UNKNOWN: 'unknown',
} as const)

export type ScopeLevel = (typeof ScopeLevel)[keyof typeof ScopeLevel]

export interface LanceDBScope {
  level: ScopeLevel
  table: string | null
  filters: Record<string, string>
  rowId: string | null
  blob: boolean
  resourcePath: string
}

function parseRowFile(name: string, config: LanceDBConfigResolved): [string, boolean] | null {
  if (name.endsWith('.md')) return [name.slice(0, -'.md'.length), false]
  if (config.blobColumn !== null) {
    const suffix = `.${config.blobExt}`
    if (name.endsWith(suffix)) return [name.slice(0, -suffix.length), true]
  }
  return null
}

function make(
  level: ScopeLevel,
  resourcePath: string,
  over: Partial<LanceDBScope> = {},
): LanceDBScope {
  return {
    level,
    table: over.table ?? null,
    filters: over.filters ?? {},
    rowId: over.rowId ?? null,
    blob: over.blob ?? false,
    resourcePath,
  }
}

export function detectScope(path: PathSpec | string, config: LanceDBConfigResolved): LanceDBScope {
  const raw = path instanceof PathSpec ? path.mountPath : path
  const key = stripSlash(raw)
  const segs = key === '' ? [] : key.split('/')

  let table: string
  let rest: string[]
  if (config.table !== null) {
    table = config.table
    rest = segs
  } else {
    if (segs.length === 0) return make(ScopeLevel.ROOT, raw)
    table = segs[0] ?? ''
    rest = segs.slice(1)
  }

  const gb = config.groupBy
  const n = gb.length

  if (rest.length <= n) {
    const filters: Record<string, string> = {}
    for (let i = 0; i < rest.length; i++) filters[gb[i] ?? ''] = rest[i] ?? ''
    return make(ScopeLevel.GROUP_DIR, raw, { table, filters })
  }

  if (rest.length === n + 1) {
    const filters: Record<string, string> = {}
    for (let i = 0; i < n; i++) filters[gb[i] ?? ''] = rest[i] ?? ''
    const parsed = parseRowFile(rest[n] ?? '', config)
    if (parsed !== null) {
      return make(ScopeLevel.ROW, raw, { table, filters, rowId: parsed[0], blob: parsed[1] })
    }
  }

  return make(ScopeLevel.UNKNOWN, raw)
}
