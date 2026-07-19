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

import {
  buildTree,
  emitStartPath,
  keep,
  rstripSlash,
  startBasename,
  type FindOptions,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import {
  escapeRegex,
  filesColl,
  gridfsPrefix,
  iterLatest,
  prefixQuery,
  rawPathOf,
  stripKeyPrefix,
} from './_client.ts'

/**
 * Translate a find -name glob into a regex fragment matching one path
 * segment. Returns null for character classes we do not translate (the
 * caller falls back to the unpushed prefix query; client-side keep()
 * still applies the exact semantics).
 */
export function globRegex(pattern: string): string | null {
  if (pattern.includes('[') || pattern.includes(']')) return null
  let out = ''
  for (const ch of pattern) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += escapeRegex(ch)
  }
  return out
}

/**
 * Build the fs.files query, pushing -name/-iname/-type/-size server-side
 * when the translation is exact. Every condition is a superset of the GNU
 * semantics (directory markers always pass the size condition, unpushable
 * globs fall back to the prefix scan), so the client-side keep() pass
 * stays authoritative.
 */
export function buildQuery(
  pfx: string,
  options: FindOptions,
  pushdown: boolean,
): Record<string, unknown> {
  const conds: Record<string, unknown>[] = []
  const base = prefixQuery(pfx)
  if (Object.keys(base).length > 0) conds.push(base)
  if (pushdown) {
    const escaped = escapeRegex(pfx)
    const globs: [string | null | undefined, string][] = [
      [options.name, ''],
      [options.iname, 'i'],
    ]
    for (const [pat, flags] of globs) {
      if (pat === undefined || pat === null) continue
      const rx = globRegex(pat)
      if (rx === null) continue
      const regex: Record<string, unknown> = { $regex: `^${escaped}(.*/)?${rx}/?$` }
      if (flags !== '') regex.$options = flags
      conds.push({ filename: regex })
    }
    if (options.type === 'f') {
      conds.push({ filename: { $not: { $regex: '/$' } } })
    } else if (options.type === 'd') {
      conds.push({ filename: { $regex: '/$' } })
    }
    if (options.minSize != null || options.maxSize != null) {
      const sizeCond: Record<string, number> = {}
      if (options.minSize != null) sizeCond.$gte = options.minSize
      if (options.maxSize != null) sizeCond.$lte = options.maxSize
      // Directory markers ride through; the client-side dirs-count-as-0
      // rule decides their fate.
      conds.push({ $or: [{ length: sizeCond }, { filename: { $regex: '/$' } }] })
    }
  }
  if (conds.length === 0) return {}
  if (conds.length === 1) return conds[0] ?? {}
  return { $and: conds }
}

export async function find(
  accessor: GridFSAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const raw = rawPathOf(path)
  const startName = startBasename(path.virtual)
  const pfx = gridfsPrefix(raw, accessor.config)
  const results: string[] = []
  const seen = { descendant: false, marker: false }
  const empty = options.empty === true
  const pushdown =
    options.tree === undefined &&
    options.nameExclude === undefined &&
    options.orNames === undefined &&
    options.pathPattern === undefined &&
    !empty
  const tree =
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: options.type,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
      empty: options.empty,
    })
  const query = buildQuery(pfx, options, pushdown)
  const narrowed = JSON.stringify(query) !== JSON.stringify(prefixQuery(pfx))
  for await (const doc of iterLatest(accessor, query)) {
    const key = doc.filename
    if (key === pfx) {
      seen.marker = true
      continue
    }
    seen.descendant = true
    const relative = key.slice(pfx.length)
    const depth = (relative.match(/\//g) ?? []).length + 1
    if (options.maxDepth !== null && options.maxDepth !== undefined && depth > options.maxDepth) {
      continue
    }
    const isDir = key.endsWith('/')
    const normKey = isDir ? key.slice(0, -1) : key
    const entryName = normKey.split('/').pop() ?? ''
    const fullPath = rstripSlash('/' + stripKeyPrefix(key, accessor.config)) || '/'
    const size = doc.length
    const isEmpty = !empty ? null : isDir ? false : size === 0
    if (
      !keep(
        { key: fullPath, name: entryName, kind: isDir ? 'd' : 'f', depth, isEmpty },
        tree,
        options.minDepth,
      )
    ) {
      continue
    }
    if (options.minSize != null || options.maxSize != null) {
      // Directories count as size 0 for -size (deliberate GNU divergence).
      const effective = isDir ? 0 : size
      if (options.minSize != null && effective < options.minSize) continue
      if (options.maxSize != null && effective > options.maxSize) continue
    }
    results.push(fullPath)
  }
  if (narrowed && !seen.descendant && !seen.marker) {
    // The narrowed query may have excluded every doc under a prefix that
    // does exist; probe so the start path still emits.
    const files = await filesColl(accessor)
    const probe = await files.findOne(
      pfx === '' ? {} : { filename: { $regex: `^${escapeRegex(pfx)}` } },
      { projection: { _id: 1 } },
    )
    seen.descendant = probe !== null
  }
  const rootKey = rstripSlash('/' + stripKeyPrefix(pfx, accessor.config)) || '/'
  if (seen.descendant || seen.marker) {
    emitStartPath(results, rootKey, startName, {
      kind: 'd',
      isEmpty: empty ? false : null,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
      minSize: options.minSize,
      maxSize: options.maxSize,
    })
  }
  return results.sort()
}
