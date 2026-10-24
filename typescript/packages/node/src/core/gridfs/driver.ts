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

import { concat } from '@struktoai/mirage-core/utils/bytes'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { chunks } from '@struktoai/mirage-core/io/cooperative'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import type {
  ChildEntry,
  ObjectMeta,
  ObjectStoreConnection,
  ObjectStoreDriver,
  TreeEntry,
} from '@struktoai/mirage-core/core/object_store/driver'
import { VFSName } from '@struktoai/mirage-core/types'
import { toIsoZ } from '@struktoai/mirage-core/utils/dates'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import {
  bucket,
  escapeRegex,
  fileById,
  filesColl,
  type GridFSFileDoc,
  iterLatest,
  latestFile,
  loadGridFSModule,
  prefixQuery,
  prune,
  retag,
  trashed,
} from './client.ts'
import { SCOPE_ERROR, TRASH_PREFIX } from './constants.ts'
import { isNoFileError } from './read.ts'

/** Match the file at `stem` plus everything beneath it. */
function subtreeQuery(stem: string): Record<string, unknown> {
  if (stem === '') return prefixQuery('')
  return {
    $or: [{ filename: stem }, { filename: { $regex: `^${escapeRegex(stem + '/')}` } }],
  }
}

function keyPrefixOf(accessor: GridFSAccessor): string {
  return accessor.config.keyPrefix ?? ''
}

function connect(accessor: GridFSAccessor): Promise<ObjectStoreConnection<GridFSAccessor>> {
  // The mongo client lives on the accessor; there is no per-op handle to
  // open or close.
  return Promise.resolve({ conn: accessor, close: () => Promise.resolve() })
}

async function* listChildren(conn: GridFSAccessor, pfx: string): AsyncIterable<ChildEntry> {
  for await (const doc of iterLatest(conn, prefixQuery(pfx))) {
    const fname = doc.filename
    if (fname === pfx) {
      yield { key: fname, kind: 'marker' }
      continue
    }
    const relative = fname.slice(pfx.length)
    const slash = relative.indexOf('/')
    if (slash === -1) {
      yield {
        key: fname,
        kind: 'f',
        size: doc.length,
        modified: toIsoZ(doc.uploadDate),
      }
    } else {
      // A deeper filename or a "seg/" directory marker both imply an
      // immediate child directory (S3 CommonPrefixes equivalent).
      yield { key: pfx + relative.slice(0, slash), kind: 'd' }
    }
  }
}

async function* listSubtree(conn: GridFSAccessor, stem: string): AsyncIterable<TreeEntry> {
  for await (const doc of iterLatest(conn, subtreeQuery(stem))) {
    yield { key: doc.filename, size: doc.length, modified: toIsoZ(doc.uploadDate) }
  }
}

async function head(conn: GridFSAccessor, key: string): Promise<ObjectMeta | null> {
  return metaOf(await latestFile(conn, key))
}

async function headRevision(
  conn: GridFSAccessor,
  _key: string,
  revision: string,
): Promise<ObjectMeta | null> {
  // A pinned stat: the revision by its _id, wherever rm or mv moved it.
  const mod = await loadGridFSModule()
  return metaOf(await fileById(conn, new mod.ObjectId(revision)))
}

function metaOf(doc: GridFSFileDoc | null): ObjectMeta | null {
  if (doc === null) return null
  const revision = doc._id.toString()
  return {
    size: doc.length,
    modified: toIsoZ(doc.uploadDate),
    fingerprint: revision,
    revision,
    extra: { file_id: revision },
  }
}

async function get(conn: GridFSAccessor, key: string): Promise<Uint8Array | null> {
  const doc = await latestFile(conn, key)
  if (doc === null) return null
  const b = await bucket(conn)
  const readable = b.openDownloadStream(doc._id)
  const chunks: Uint8Array[] = []
  for await (const chunk of readable as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
  }
  return concat(chunks)
}

/**
 * Upload one new revision of `key`, then prune past retention. Every op
 * that adds a revision goes through here, so none can skip
 * `keepRevisions`. Older revisions stay in fs.files, so reads pinned to an
 * old `_id` keep working, and the new `_id` wins both keys of the
 * latest-first sort, so it is what `head` answers next, spelled the same
 * way.
 */
async function upload(
  conn: GridFSAccessor,
  key: string,
  source: AsyncIterable<Uint8Array>,
): Promise<ObjectMeta> {
  const stream = (await bucket(conn)).openUploadStream(key)
  let size = 0
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const part of source) {
      size += part.byteLength
      yield part
    }
  }
  try {
    await pipeline(Readable.from(counted()), stream)
  } catch (error) {
    try {
      await stream.abort()
    } catch (cleanup) {
      console.debug('Could not abort GridFS upload', cleanup)
    }
    throw error
  }
  // A key's revisions, live and trashed, each counted per filename.
  await prune(conn, { filename: { $in: [key, trashed(key)] } })
  const revision = stream.id.toString()
  return { size, fingerprint: revision, revision }
}

/**
 * Move every revision of `key` (or under it, for a `subtree` prefix) to the
 * trash, then prune the trash past retention. Every op that takes a name
 * away goes through here, so none deletes a revision outright or skips
 * `keepRevisions`. The revisions keep their `_id`, so a snapshot pinned to
 * one still reads it.
 */
async function remove(conn: GridFSAccessor, key: string, subtree: boolean): Promise<void> {
  const [live, gone] = subtree
    ? [prefixQuery(key), prefixQuery(trashed(key))]
    : [{ filename: key }, { filename: trashed(key) }]
  await retag(conn, live, TRASH_PREFIX)
  await prune(conn, gone)
}

function put(conn: GridFSAccessor, key: string, data: Uint8Array): Promise<ObjectMeta | null> {
  return upload(conn, key, chunks(data))
}

function putStream(conn: GridFSAccessor, key: string, data: ByteSource): Promise<ObjectMeta> {
  return upload(conn, key, chunks(data))
}

async function deleteFile(conn: GridFSAccessor, key: string): Promise<void> {
  // rm semantics: silent on a missing key, like S3's DeleteObject, and no
  // more destructive than its delete marker.
  await remove(conn, key, false)
}

async function deletePrefix(conn: GridFSAccessor, pfx: string): Promise<void> {
  await remove(conn, pfx, true)
}

async function copyFile(conn: GridFSAccessor, srcKey: string, dstKey: string): Promise<boolean> {
  // Copies the latest revision only (mirrors S3 CopyObject), streamed so
  // large files never buffer fully in memory.
  const doc = await latestFile(conn, srcKey)
  if (doc === null) return false
  const readable = (await bucket(conn)).openDownloadStream(doc._id)
  await upload(conn, dstKey, readable as AsyncIterable<Uint8Array>)
  return true
}

async function moveFile(conn: GridFSAccessor, srcKey: string, dstKey: string): Promise<boolean> {
  // Server-side: retag every revision's filename instead of copying
  // bytes, so the whole revision history moves with the file.
  if ((await latestFile(conn, srcKey)) === null) return false
  if (dstKey !== srcKey) await remove(conn, dstKey, false)
  await retag(conn, { filename: srcKey }, dstKey, srcKey)
  return true
}

/**
 * Retag every revision under `srcPfx` to sit under `dstPfx`.
 *
 * A directory is a filename prefix plus the zero-byte `key/` marker
 * mkdir writes, and the prefix query returns both, so one pass moves the
 * marker and the whole subtree together. Returns whether any revision
 * was found under the source prefix.
 */
async function movePrefix(conn: GridFSAccessor, srcPfx: string, dstPfx: string): Promise<boolean> {
  if (dstPfx !== srcPfx) {
    if (!(await probePrefix(conn, srcPfx))) return false
    await remove(conn, dstPfx, true)
  }
  const moved = await retag(conn, prefixQuery(srcPfx), dstPfx, srcPfx)
  return moved > 0
}

async function probePrefix(conn: GridFSAccessor, pfx: string): Promise<boolean> {
  const files = await filesColl(conn)
  const doc = await files.findOne(prefixQuery(pfx), { projection: { _id: 1 } })
  return doc !== null
}

export const DRIVER: ObjectStoreDriver<GridFSAccessor, GridFSAccessor> = {
  vfs: VFSName.GRIDFS,
  scopeError: SCOPE_ERROR,
  keyPrefixOf,
  connect,
  listChildren,
  listSubtree,
  head,
  headRevision,
  get,
  put,
  putStream,
  deleteFile,
  deletePrefix,
  moveFile,
  movePrefix,
  copyFile,
  probePrefix,
  isNotFound: isNoFileError,
}
