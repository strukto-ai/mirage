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

import { Readable, Writable } from 'node:stream'
import type { Db } from 'mongodb'
import { PathSpec } from '@struktoai/mirage-core/types'
import { concat } from '@struktoai/mirage-core/utils/bytes'
import { GridFSAccessor } from '../../../src/accessor/gridfs.ts'
import type { GridFSConfig } from '../../../src/vfs/gridfs/config.ts'

type Query = Record<string, unknown>

/**
 * One revision: an `_id` whose string sorts in upload order, so the
 * newest-wins sort orders revisions as the real ObjectIds would.
 */
export interface FakeDoc {
  _id: string
  filename: string
  length: number
  uploadDate: Date
}

const EPOCH = Date.UTC(2026, 0, 1)

/** The ObjectId of a pinned read: the fake's string ids as they are. */
class FakeObjectId {
  constructor(readonly id: string) {}

  toString(): string {
    return this.id
  }
}

/** Whether a files document matches the query language the driver uses. */
function selects(query: Query, doc: FakeDoc): boolean {
  for (const [field, spec] of Object.entries(query)) {
    if (field === '$or') {
      if (!(spec as Query[]).some((sub) => selects(sub, doc))) return false
      continue
    }
    const value = doc[field as keyof FakeDoc]
    if (typeof spec !== 'object' || spec === null || spec instanceof FakeObjectId) {
      if (String(value) !== String(spec)) return false
    } else if ('$regex' in spec) {
      if (!new RegExp((spec as { $regex: string }).$regex).test(value as string)) return false
    } else if ('$in' in spec) {
      if (!(spec as { $in: unknown[] }).$in.includes(value)) return false
    } else {
      throw new Error(`unsupported query ${JSON.stringify(spec)}`)
    }
  }
  return true
}

/** The value of the aggregation expressions `retag` sends. */
function evaluate(expr: unknown, doc: FakeDoc): unknown {
  if (typeof expr === 'string') {
    return expr.startsWith('$') ? doc[expr.slice(1) as keyof FakeDoc] : expr
  }
  if (typeof expr === 'number') return expr
  const [[op, args]] = Object.entries(expr as Record<string, unknown>) as [[string, unknown]]
  if (op === '$concat') return (args as unknown[]).map((arg) => evaluate(arg, doc)).join('')
  if (op === '$strLenCP') return Array.from(evaluate(args, doc) as string).length
  if (op === '$substrCP') {
    const [text, start, count] = (args as unknown[]).map((arg) => evaluate(arg, doc)) as [
      string,
      number,
      number,
    ]
    return Array.from(text)
      .slice(start, start + count)
      .join('')
  }
  throw new Error(`unsupported expression ${op}`)
}

// LATEST_SORT: uploadDate descending, then _id descending.
function latestFirst(a: FakeDoc, b: FakeDoc): number {
  const byDate = b.uploadDate.getTime() - a.uploadDate.getTime()
  return byDate !== 0 ? byDate : b._id.localeCompare(a._id)
}

/**
 * A GridFS bucket in memory: the files collection, its chunks and the bucket
 * API the driver, the reads and the event hook call. Twin of the Python
 * `FakeStore` (`tests/fixtures/gridfs_store.py`).
 */
export class FakeStore {
  docs: FakeDoc[] = []
  readonly chunks = new Map<string, Uint8Array>()
  private uploads = 0
  private minted = 0

  constructor(names: string[] = []) {
    for (const name of names) this.upload(name, new Uint8Array(0))
  }

  /**
   * Add one revision of `filename` holding `data`. `sameTime` reuses the
   * previous upload's `uploadDate`, so only the `_id` tells the two apart.
   */
  upload(filename: string, data: Uint8Array, sameTime = false): string {
    if (!sameTime) this.uploads += 1
    this.minted += 1
    const id = `oid-${String(this.minted).padStart(4, '0')}`
    this.docs.push({
      _id: id,
      filename,
      length: data.byteLength,
      uploadDate: new Date(EPOCH + this.uploads * 1000),
    })
    this.chunks.set(id, data)
    return id
  }

  /** Every revision's filename, in upload order. */
  names(): string[] {
    return this.docs.map((doc) => doc.filename)
  }

  /** The `_id` of each revision of `filename`, oldest first. */
  ids(filename: string): string[] {
    return this.docs.filter((doc) => doc.filename === filename).map((doc) => doc._id)
  }

  private match(query: Query): FakeDoc[] {
    return this.docs.filter((doc) => selects(query, doc))
  }

  // The files collection.

  find(query: Query, options: { sort?: Record<string, 1 | -1> } = {}): AsyncIterable<FakeDoc> {
    const found = this.match(query)
    for (const [field, direction] of Object.entries(options.sort ?? {}).reverse()) {
      found.sort((a, b) => {
        const [x, y] = [a[field as keyof FakeDoc], b[field as keyof FakeDoc]]
        const order = x < y ? -1 : x > y ? 1 : 0
        return order * direction
      })
    }
    return Readable.from(found.map((doc) => ({ ...doc })))
  }

  findOne(query: Query, options: { sort?: unknown } = {}): Promise<FakeDoc | null> {
    const found = this.match(query)
    if (options.sort !== undefined) found.sort(latestFirst)
    const first = found[0]
    return Promise.resolve(first === undefined ? null : { ...first })
  }

  countDocuments(query: Query, options: { limit: number }): Promise<number> {
    return Promise.resolve(Math.min(this.match(query).length, options.limit))
  }

  updateOne(query: Query, update: { $set: Partial<FakeDoc> }): Promise<void> {
    for (const doc of this.match(query).slice(0, 1)) Object.assign(doc, update.$set)
    return Promise.resolve()
  }

  updateMany(
    query: Query,
    update: { $set: Partial<FakeDoc> } | { $set: Record<string, unknown> }[],
  ): Promise<{ matchedCount: number }> {
    const found = this.match(query)
    for (const doc of found) {
      if (Array.isArray(update)) {
        for (const stage of update) {
          for (const [field, expr] of Object.entries(stage.$set)) {
            Object.assign(doc, { [field]: evaluate(expr, doc) })
          }
        }
      } else {
        Object.assign(doc, update.$set)
      }
    }
    return Promise.resolve({ matchedCount: found.length })
  }

  deleteMany(query: Query): Promise<void> {
    if ('files_id' in query) {
      for (const id of (query.files_id as { $in: string[] }).$in) this.chunks.delete(id)
      return Promise.resolve()
    }
    const gone = new Set((query._id as { $in: string[] }).$in)
    this.docs = this.docs.filter((doc) => !gone.has(doc._id))
    return Promise.resolve()
  }

  aggregate(pipeline: Query[]): AsyncIterable<Record<string, unknown>> {
    // The two pipelines the client builds: newest per filename (iterLatest)
    // and every _id per filename, newest first (prune).
    const docs = this.match(pipeline[0]?.$match as Query).sort(
      (a, b) => a.filename.localeCompare(b.filename) || latestFirst(a, b),
    )
    const grouped = new Map<string, FakeDoc[]>()
    for (const doc of docs) grouped.set(doc.filename, [...(grouped.get(doc.filename) ?? []), doc])
    const fields = (pipeline[2] as { $group: Query }).$group
    const out: Record<string, unknown>[] = []
    for (const [name, revisions] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [newest, ...rest] = revisions
      if (newest === undefined) continue
      const ids = [newest, ...rest].map((doc) => doc._id)
      out.push(
        'ids' in fields
          ? { _id: name, ids }
          : { _id: name, fid: newest._id, length: newest.length, uploadDate: newest.uploadDate },
      )
    }
    return Readable.from(out)
  }

  // The bucket.

  openUploadStream(filename: string): Writable & { id: string; abort: () => Promise<void> } {
    const parts: Uint8Array[] = []
    const upload = Object.assign(
      new Writable({
        write: (chunk: Uint8Array, _encoding, done) => {
          parts.push(chunk.slice())
          done()
        },
        final: (done) => {
          upload.id = this.upload(filename, concat(parts))
          done()
        },
      }),
      { id: 'pending', abort: () => Promise.resolve() },
    )
    return upload
  }

  openDownloadStream(fileId: string | FakeObjectId): Readable {
    const id = String(fileId)
    const data = this.chunks.get(id)
    if (data === undefined) {
      return new Readable({
        read() {
          this.destroy(new Error(`FileNotFound: file ${id} was not found`))
        },
      })
    }
    return Readable.from([data])
  }
}

class FakeAccessor extends GridFSAccessor {
  constructor(
    config: GridFSConfig,
    private readonly store: FakeStore,
  ) {
    super(config)
  }

  // Both collections of the bucket are the one store, so the client's
  // real `filesColl` and `chunksColl` reach it without a connection.
  override db(): Promise<Db> {
    return Promise.resolve({ collection: () => this.store } as unknown as Db)
  }
}

/** A GridFS accessor whose database is `store`. */
export function makeAccessor(store: FakeStore, config: Partial<GridFSConfig> = {}): GridFSAccessor {
  return new FakeAccessor({ uri: 'mongodb://localhost:27017', database: 'db', ...config }, store)
}

export function spec(key: string): PathSpec {
  return new PathSpec({ vfsPath: key, virtual: `/mnt/${key}`, directory: '/mnt' })
}

/**
 * What `vi.mock('./client.ts')` hands the modules under test: the bucket is
 * the current store, and ObjectIds are the fake's strings. The collections
 * need no mock, since the accessor's database is the store.
 */
export function mockedClient(
  actual: Record<string, unknown>,
  current: () => FakeStore,
): Record<string, unknown> {
  return {
    ...actual,
    bucket: () => Promise.resolve(current()),
    loadGridFSModule: () => Promise.resolve({ ObjectId: FakeObjectId }),
  }
}
