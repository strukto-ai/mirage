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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import {
  countDocuments,
  findDocuments,
  findSnapshot,
  iterDocuments,
  iterInserts,
} from './client.ts'
import { entityGuard } from './readdir.ts'
import { detectScope, entityKind } from './scope.ts'
import { EntityKind, PRIMARY_KEY } from './types.ts'
import { efbig, enoent } from '../../errors/fs.ts'

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
      ? new PathSpec({ vfsPath: stripSlash(path), virtual: path, directory: path })
      : path
  const scope = detectScope(ps)
  if (scope.kind !== 'documents') {
    throw enoent(ps.virtual)
  }
  // The entity guard is what applies the mount's `databases` filter; this
  // stream is the read_stream op, which a caller reaches without a stat first
  // (a redirect, a runtime's open), so it proves the collection itself
  // rather than trusting the names in the path.
  await entityGuard(accessor, scope, ps.virtual)
  const elide = elisionPaths(accessor, scope.slots.database ?? '', scope.slots.name ?? '')
  const batchSize = options.batchSize ?? 100
  for await (const doc of iterDocuments(
    accessor,
    scope.slots.database ?? '',
    scope.slots.name ?? '',
    {
      sort: { [PRIMARY_KEY]: 1 },
      batchSize,
    },
  )) {
    const final = elide.size > 0 ? applyElision(doc, elide) : doc
    yield encodeLine(final)
  }
}

/**
 * The last `n` documents of a collection or view, as its documents.jsonl
 * renders them. Sorts by primary key descending with a limit instead of
 * streaming the whole collection. `maxDocLimit` is the most documents one such
 * read returns: a count past it that the collection could fill throws EFBIG.
 * Null for any other file. Mirrors `last_lines` in
 * `mirage/core/mongodb/stream.py`.
 */
export async function lastLines(
  accessor: MongoDBAccessor,
  path: PathSpec,
  n: number,
  _index?: IndexCacheStore,
): Promise<Uint8Array | null> {
  const scope = detectScope(path)
  if (scope.kind !== 'documents') return null
  await entityGuard(accessor, scope, path.virtual)
  const database = scope.slots.database ?? ''
  const name = scope.slots.name ?? ''
  const docs = await findDocuments(
    accessor,
    database,
    name,
    {},
    { limit: await docLimit(accessor, path, database, name, n), sort: { [PRIMARY_KEY]: -1 } },
  )
  return renderLines(accessor, database, name, docs.reverse())
}

// How many of the last `n` documents one read returns: `n` up to
// `maxDocLimit`, and EFBIG for a count past it that the collection fills.
// Mirrors Python's `_doc_limit`.
async function docLimit(
  accessor: MongoDBAccessor,
  path: PathSpec,
  database: string,
  name: string,
  n: number,
): Promise<number> {
  const cap = accessor.config.maxDocLimit
  if (n > cap && (await countDocuments(accessor, database, name)) > cap) throw efbig(path)
  return Math.min(n, cap)
}

// Documents as their documents.jsonl lines, with the mount's hidden fields
// left out. Mirrors Python's `_render_lines`.
function renderLines(
  accessor: MongoDBAccessor,
  database: string,
  name: string,
  docs: Record<string, unknown>[],
): Uint8Array {
  const elide = elisionPaths(accessor, database, name)
  const lines = docs.map(
    (doc) => `${stringifyDoc(elide.size > 0 ? applyElision(doc, elide) : doc)}\n`,
  )
  return new TextEncoder().encode(lines.join(''))
}

/**
 * How many documents a collection or view holds, one line each in its
 * documents.jsonl, by `countDocuments`. Null for any other file. Mirrors
 * `line_count` in `mirage/core/mongodb/stream.py`.
 */
export async function lineCount(
  accessor: MongoDBAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<number | null> {
  const scope = detectScope(path)
  if (scope.kind !== 'documents') return null
  await entityGuard(accessor, scope, path.virtual)
  return countDocuments(accessor, scope.slots.database ?? '', scope.slots.name ?? '')
}

/**
 * The last `n` documents of a collection, then each one inserted after them,
 * one documents.jsonl line each. Null for a view, which has no change stream,
 * and for any other file. The last documents are read at one snapshot and the
 * change stream holds each insert after it, so the two meet at one point: no
 * insert is lost or printed twice.
 * Mirrors `follow` in `mirage/core/mongodb/stream.py`.
 */
export async function follow(
  accessor: MongoDBAccessor,
  path: PathSpec,
  n: number,
  _index?: IndexCacheStore,
): Promise<AsyncIterableIterator<Uint8Array> | null> {
  const scope = detectScope(path)
  if (scope.kind !== 'documents' || entityKind(scope) !== EntityKind.COLLECTION) return null
  await entityGuard(accessor, scope, path.virtual)
  const database = scope.slots.database ?? ''
  const name = scope.slots.name ?? ''
  const limit = n > 0 ? await docLimit(accessor, path, database, name, n) : 1
  const [docs, after] = await findSnapshot(accessor, database, name, {
    limit,
    sort: { [PRIMARY_KEY]: -1 },
  })
  return followed(accessor, database, name, after, docs.slice(0, n).reverse())
}

// `docs`, then each document inserted after `after`, rendered as lines. An
// iterator rather than a generator: a generator queues `return` behind a pull
// waiting for the next insert, so an idle `tail -f` could never close its
// change stream. Mirrors `_followed` in `mirage/core/mongodb/stream.py`.
function followed(
  accessor: MongoDBAccessor,
  database: string,
  name: string,
  after: unknown,
  docs: Record<string, unknown>[],
): AsyncIterableIterator<Uint8Array> {
  const first = renderLines(accessor, database, name, docs)
  let pending: Uint8Array | null = first.byteLength > 0 ? first : null
  let inserts: AsyncIterableIterator<Record<string, unknown>> | null = null
  let closed = false
  const done: IteratorResult<Uint8Array> = { value: undefined, done: true }
  return {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (pending !== null) {
        const value = pending
        pending = null
        return { value, done: false }
      }
      if (closed) return done
      inserts ??= iterInserts(accessor, database, name, after)
      const step = await inserts.next()
      if (step.done === true) return done
      return { value: renderLines(accessor, database, name, [step.value]), done: false }
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      closed = true
      pending = null
      await inserts?.return?.()
      return done
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}
