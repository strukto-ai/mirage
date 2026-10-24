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
import * as kp from '@struktoai/mirage-core/utils/key_prefix'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import { TRASH_PREFIX } from './constants.ts'

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

// Each filename's revisions together, newest first, the order prune keeps
// them in.
const PRUNE_SORT: Record<string, -1> = { filename: -1, uploadDate: -1, _id: -1 }

const BATCH = 1000

let cachedModule: Promise<GridFSModule> | null = null

export async function loadGridFSModule(): Promise<GridFSModule> {
  cachedModule ??= loadOptionalPeer(() => import('mongodb') as unknown as Promise<GridFSModule>, {
    feature: 'GridFSVFS',
    packageName: 'mongodb',
  })
  return cachedModule
}

export function gridfsKey(path: string, config: GridFSConfig): string {
  return kp.apply(config.keyPrefix ?? '', path)
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

/**
 * Match the live revisions under a key prefix; `''` is the whole store,
 * less the trash, which no mount key can reach.
 */
export function prefixQuery(pfx: string): Record<string, unknown> {
  if (pfx === '') return { filename: { $regex: `^(?!${escapeRegex(TRASH_PREFIX)})` } }
  return { filename: { $regex: `^${escapeRegex(pfx)}` } }
}

/** The filename `rm` moves a key's revisions to. */
export function trashed(key: string): string {
  return TRASH_PREFIX + key
}

export async function latestFile(
  accessor: GridFSAccessor,
  key: string,
): Promise<GridFSFileDoc | null> {
  const files = await filesColl(accessor)
  const doc = await files.findOne({ filename: key }, { sort: LATEST_SORT })
  return doc as GridFSFileDoc | null
}

export async function fileById(
  accessor: GridFSAccessor,
  id: ObjectId,
): Promise<GridFSFileDoc | null> {
  const files = await filesColl(accessor)
  const doc = await files.findOne({ _id: id })
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

/**
 * Rename every revision matching a query, in one server-side update: each
 * filename loses its first `strip` characters and gains `prefix`. The
 * revisions keep their `_id` and chunks, so a read pinned to one still finds
 * it under the new name. Returns how many revisions the query selected.
 */
export async function retag(
  accessor: GridFSAccessor,
  query: Record<string, unknown>,
  prefix: string,
  strip = 0,
): Promise<number> {
  const files = await filesColl(accessor)
  const rest =
    strip === 0 ? '$filename' : { $substrCP: ['$filename', strip, { $strLenCP: '$filename' }] }
  const result = await files.updateMany(query, [
    { $set: { filename: { $concat: [prefix, rest] } } },
  ])
  return result.matchedCount
}

/**
 * Move every revision matching a query into the trash: what `rm` and an
 * overwriting `mv` do instead of deleting. The name reads as gone, and the
 * revisions stay for pinned reads until `keepRevisions` prunes them.
 */
export async function trash(
  accessor: GridFSAccessor,
  query: Record<string, unknown>,
): Promise<void> {
  await retag(accessor, query, TRASH_PREFIX)
}

/**
 * Delete the revisions past `keepRevisions` of each matching name, newest
 * first; an unset `keepRevisions` keeps them all. The query names the
 * revisions to count, live or trashed.
 */
export async function prune(
  accessor: GridFSAccessor,
  query: Record<string, unknown>,
): Promise<void> {
  const keep = accessor.config.keepRevisions
  if (keep === undefined) return
  // Streamed newest first within each filename and deleted in batches, so no
  // history, however long, is ever held in one document or one array.
  const files = await filesColl(accessor)
  const cursor = files.find(query, {
    projection: { _id: 1, filename: 1 },
    sort: PRUNE_SORT,
    allowDiskUse: true,
  })
  let name: string | null = null
  let kept = 0
  let stale: ObjectId[] = []
  for await (const doc of cursor) {
    if (doc.filename !== name) {
      name = doc.filename as string
      kept = 0
    }
    if (kept < keep) {
      kept += 1
      continue
    }
    stale.push(doc._id)
    if (stale.length >= BATCH) {
      await deleteIds(accessor, stale)
      stale = []
    }
  }
  await deleteIds(accessor, stale)
}

/** Delete revisions (file doc + chunks) by `_id`. */
export async function deleteIds(accessor: GridFSAccessor, ids: ObjectId[]): Promise<void> {
  const files = await filesColl(accessor)
  const chunks = await chunksColl(accessor)
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    await chunks.deleteMany({ files_id: { $in: batch } })
    await files.deleteMany({ _id: { $in: batch } })
  }
}
