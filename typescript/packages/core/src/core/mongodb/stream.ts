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

import { stripSlash } from '../../utils/slash.ts'
import { EJSON } from 'bson'
import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { PathSpec } from '../../types.ts'
import { iterDocuments, iterInserts } from './_client.ts'
import { detectScope } from './scope.ts'
import { PRIMARY_KEY, ScopeLevel } from './types.ts'

function notFound(p: string): Error {
  const err = new Error(p) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

export function applyElision(
  value: Record<string, unknown>,
  paths: Set<string>,
): Record<string, unknown> {
  const grouped: Record<string, Set<string>> = {}
  const leaves = new Set<string>()
  for (const p of paths) {
    const dot = p.indexOf('.')
    if (dot === -1) {
      leaves.add(p)
    } else {
      const head = p.slice(0, dot)
      const tail = p.slice(dot + 1)
      grouped[head] ??= new Set()
      grouped[head].add(tail)
    }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (leaves.has(k)) continue
    if (
      grouped[k] !== undefined &&
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      v.constructor === Object
    ) {
      out[k] = applyElision(v as Record<string, unknown>, grouped[k])
    } else {
      out[k] = v
    }
  }
  return out
}

export function elisionPaths(
  accessor: MongoDBAccessor,
  database: string,
  name: string,
): Set<string> {
  const key = `${database}.${name}`
  const fields = accessor.config.elideFields[key] ?? []
  return new Set(fields)
}

function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(', ')}]`
  if (typeof value === 'object') {
    const parts: string[] = []
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      parts.push(`${JSON.stringify(k)}: ${pyJsonDumps(v)}`)
    }
    return `{${parts.join(', ')}}`
  }
  return 'null'
}

export function stringifyDoc(doc: Record<string, unknown>): string {
  return pyJsonDumps(EJSON.serialize(doc, { relaxed: true }))
}

function encodeLine(doc: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`${stringifyDoc(doc)}\n`)
}

export async function* readStream(
  accessor: MongoDBAccessor,
  path: PathSpec | string,
  options: { batchSize?: number } = {},
): AsyncIterableIterator<Uint8Array> {
  const ps =
    typeof path === 'string'
      ? new PathSpec({ resourcePath: stripSlash(path), virtual: path, directory: path })
      : path
  const scope = detectScope(ps)
  if (scope.level !== ScopeLevel.DOCUMENTS || scope.database === null || scope.name === null) {
    throw notFound(ps.virtual)
  }
  const elide = elisionPaths(accessor, scope.database, scope.name)
  const batchSize = options.batchSize ?? 100
  for await (const doc of iterDocuments(accessor, scope.database, scope.name, {
    sort: { [PRIMARY_KEY]: 1 },
    batchSize,
  })) {
    const final = elide.size > 0 ? applyElision(doc, elide) : doc
    yield encodeLine(final)
  }
}

export async function* watchStream(
  accessor: MongoDBAccessor,
  path: PathSpec | string,
): AsyncIterableIterator<Uint8Array> {
  const ps =
    typeof path === 'string'
      ? new PathSpec({ resourcePath: stripSlash(path), virtual: path, directory: path })
      : path
  const scope = detectScope(ps)
  if (scope.level !== ScopeLevel.DOCUMENTS || scope.database === null || scope.name === null) {
    throw notFound(ps.virtual)
  }
  const elide = elisionPaths(accessor, scope.database, scope.name)
  for await (const doc of iterInserts(accessor, scope.database, scope.name)) {
    const final = elide.size > 0 ? applyElision(doc, elide) : doc
    yield encodeLine(final)
  }
}
