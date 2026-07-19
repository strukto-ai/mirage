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

import type { Collection, Db, Document, GridFSBucket, ObjectId } from 'mongodb'
import { keyPrefix as kp, mountPrefixOf, type PathSpec } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../../optional_peer.ts'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../resource/gridfs/config.ts'

export interface GridFSFileDoc {
  _id: ObjectId
  filename: string
  length: number
  uploadDate: Date
}

interface GridFSModule {
  GridFSBucket: new (
    db: Db,
    options?: { bucketName?: string; chunkSizeBytes?: number },
  ) => GridFSBucket
  ObjectId: new (id?: string) => ObjectId
}

// Newest revision of a filename wins; _id breaks uploadDate ties because
// ObjectIds are monotonic within a process.
const LATEST_SORT: Record<string, -1> = { uploadDate: -1, _id: -1 }

const BATCH = 1000

let cachedModule: Promise<GridFSModule> | null = null

export async function loadGridFSModule(): Promise<GridFSModule> {
  cachedModule ??= loadOptionalPeer(() => import('mongodb') as unknown as Promise<GridFSModule>, {
    feature: 'GridFSResource',
    packageName: 'mongodb',
  })
  return cachedModule
}

export function gridfsKey(path: string, config: GridFSConfig): string {
  return kp.apply(config.keyPrefix ?? '', path)
}

export function gridfsPrefix(path: string, config: GridFSConfig): string {
  return kp.applyDir(config.keyPrefix ?? '', path)
}

export function stripKeyPrefix(key: string, config: GridFSConfig): string {
  return kp.strip(config.keyPrefix ?? '', key)
}

export function rawPathOf(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  return prefix !== '' && path.virtual.startsWith(prefix)
    ? path.virtual.slice(prefix.length) || '/'
    : path.virtual
}

function bucketName(config: GridFSConfig): string {
  return config.bucket ?? 'fs'
}

export async function filesColl(accessor: GridFSAccessor): Promise<Collection> {
  const db = await accessor.db()
  return db.collection(`${bucketName(accessor.config)}.files`)
}

async function chunksColl(accessor: GridFSAccessor): Promise<Collection> {
  const db = await accessor.db()
  return db.collection(`${bucketName(accessor.config)}.chunks`)
}

export async function bucket(accessor: GridFSAccessor): Promise<GridFSBucket> {
  const mod = await loadGridFSModule()
  const db = await accessor.db()
  const options: { bucketName: string; chunkSizeBytes?: number } = {
    bucketName: bucketName(accessor.config),
  }
  if (accessor.config.chunkSizeBytes !== undefined) {
    options.chunkSizeBytes = accessor.config.chunkSizeBytes
  }
  return new mod.GridFSBucket(db, options)
}

export function escapeRegex(raw: string): string {
  let out = ''
  for (const ch of raw) {
    out += '\\^$.|?*+()[]{}'.includes(ch) ? `\\${ch}` : ch
  }
  return out
}

export function prefixQuery(pfx: string): Record<string, unknown> {
  if (pfx === '') return {}
  return { filename: { $regex: `^${escapeRegex(pfx)}` } }
}

export async function latestFile(
  accessor: GridFSAccessor,
  key: string,
): Promise<GridFSFileDoc | null> {
  const files = await filesColl(accessor)
  const doc = await files.findOne({ filename: key }, { sort: LATEST_SORT })
  return doc as GridFSFileDoc | null
}

/**
 * Yield the newest revision of each filename matching a query, sorted by
 * filename. Mirrors Python's `iter_latest`.
 */
export async function* iterLatest(
  accessor: GridFSAccessor,
  query: Record<string, unknown>,
): AsyncIterable<GridFSFileDoc> {
  const files = await filesColl(accessor)
  const pipeline: Document[] = [
    { $match: query },
    { $sort: { filename: 1, uploadDate: -1, _id: -1 } },
    {
      $group: {
        _id: '$filename',
        fid: { $first: '$_id' },
        length: { $first: '$length' },
        uploadDate: { $first: '$uploadDate' },
      },
    },
    { $sort: { _id: 1 } },
  ]
  for await (const doc of files.aggregate(pipeline)) {
    yield {
      filename: doc._id as string,
      _id: doc.fid as ObjectId,
      length: doc.length as number,
      uploadDate: doc.uploadDate as Date,
    }
  }
}

/** Delete every revision (file doc + chunks) matching a query. */
export async function deleteAll(
  accessor: GridFSAccessor,
  query: Record<string, unknown>,
): Promise<void> {
  const files = await filesColl(accessor)
  const chunks = await chunksColl(accessor)
  const ids: ObjectId[] = []
  for await (const doc of files.find(query, { projection: { _id: 1 } })) {
    ids.push(doc._id)
  }
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    await chunks.deleteMany({ files_id: { $in: batch } })
    await files.deleteMany({ _id: { $in: batch } })
  }
}
