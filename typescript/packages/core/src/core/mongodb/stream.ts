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
  iterDocuments,
  iterInserts,
  operationTime,
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
  return lastLinesOf(accessor, path, scope.slots.database ?? '', scope.slots.name ?? '', n)
}

// The last `n` documents rendered as lines, past the guard. Mirrors Python's
// `_last_lines_of`.
async function lastLinesOf(
  accessor: MongoDBAccessor,
  path: PathSpec,
  database: string,
  name: string,
  n: number,
): Promise<Uint8Array> {
  const cap = accessor.config.maxDocLimit
  if (n > cap && (await countDocuments(accessor, database, name)) > cap) throw efbig(path)
  const docs = await findDocuments(
    accessor,
    database,
    name,
    {},
    { limit: Math.min(n, cap), sort: { [PRIMARY_KEY]: -1 } },
  )
  docs.reverse()
  if (docs.length === 0) return new Uint8Array()
  const elide = elisionPaths(accessor, database, name)
  const lines = docs.map((doc) => stringifyDoc(elide.size > 0 ? applyElision(doc, elide) : doc))
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
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
 * and for any other file. The change stream starts at the cluster's operation
 * time from before the last documents are read, so nothing inserted in
 * between is lost, and a document that both print is skipped the second time.
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
  const after = await operationTime(accessor, database)
  const first = n > 0 ? await lastLinesOf(accessor, path, database, name, n) : new Uint8Array()
  return followed(accessor, database, name, after, first)
}

// `first`, then each document inserted after `after` that it does not already
// hold, rendered as a line. An iterator rather than a generator: a generator
// queues `return` behind a pull waiting for the next insert, so an idle
// `tail -f` could never close its change stream. Mirrors `_followed` in
// `mirage/core/mongodb/stream.py`.
function followed(
  accessor: MongoDBAccessor,
  database: string,
  name: string,
  after: unknown,
  first: Uint8Array,
): AsyncIterableIterator<Uint8Array> {
  const elide = elisionPaths(accessor, database, name)
  const printed = new Set(
    new TextDecoder()
      .decode(first)
      .split('\n')
      .slice(0, -1)
      .map((line) => `${line}\n`),
  )
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
      for (;;) {
        const step = await inserts.next()
        if (step.done === true) return done
        const doc = elide.size > 0 ? applyElision(step.value, elide) : step.value
        const line = `${stringifyDoc(doc)}\n`
        if (printed.delete(line)) continue
        return { value: new TextEncoder().encode(line), done: false }
      }
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
