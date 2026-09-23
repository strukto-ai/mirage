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

import type {
  ChildEntry,
  FindHints,
  ObjectMeta,
  ObjectStoreConnection,
  ObjectStoreDriver,
  TreeEntry,
} from '@struktoai/mirage-core/core/object_store/driver'
import type { FindOptions } from '@struktoai/mirage-core/vfs/base'
import { VFSName } from '@struktoai/mirage-core/types'
import { toIsoZ } from '@struktoai/mirage-core/utils/dates'
import type { ObjectId } from 'mongodb'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import {
  bucket,
  deleteAll,
  escapeRegex,
  filesColl,
  iterLatest,
  latestFile,
  prefixQuery,
} from './client.ts'
import { SCOPE_ERROR } from './constants.ts'
import { isNoFileError } from './read.ts'

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

/** Match the file at `stem` plus everything beneath it. */
function subtreeQuery(stem: string): Record<string, unknown> {
  if (stem === '') return {}
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

async function* listTree(conn: GridFSAccessor, pfx: string): AsyncIterable<TreeEntry> {
  for await (const doc of iterLatest(conn, prefixQuery(pfx))) {
    yield { key: doc.filename, size: doc.length, modified: toIsoZ(doc.uploadDate) }
  }
}

async function* listSubtree(conn: GridFSAccessor, stem: string): AsyncIterable<TreeEntry> {
  for await (const doc of iterLatest(conn, subtreeQuery(stem))) {
    yield { key: doc.filename, size: doc.length, modified: toIsoZ(doc.uploadDate) }
  }
}

async function* iterQuery(
  conn: GridFSAccessor,
  query: Record<string, unknown>,
): AsyncIterable<TreeEntry> {
  for await (const doc of iterLatest(conn, query)) {
    yield { key: doc.filename, size: doc.length, modified: toIsoZ(doc.uploadDate) }
  }
}

function findTree(
  conn: GridFSAccessor,
  pfx: string,
  hints: FindHints,
): [AsyncIterable<TreeEntry>, boolean] {
  const query = buildQuery(pfx, hints, hints.pushdown)
  return [iterQuery(conn, query), JSON.stringify(query) !== JSON.stringify(prefixQuery(pfx))]
}

async function head(conn: GridFSAccessor, key: string): Promise<ObjectMeta | null> {
  const doc = await latestFile(conn, key)
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
  let total = 0
  for await (const chunk of readable as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function put(
  conn: GridFSAccessor,
  key: string,
  data: Uint8Array,
): Promise<ObjectMeta | null> {
  // Uploads a new revision; older revisions stay in fs.files, so reads
  // pinned to an old revision _id keep working (GridFS-native
  // versioning). The new _id wins both keys of the latest-first sort, so
  // it is what `head` answers next, spelled the same way.
  const b = await bucket(conn)
  const upload = b.openUploadStream(key)
  await new Promise<void>((resolve, reject) => {
    upload.on('error', reject)
    upload.on('finish', () => {
      resolve()
    })
    upload.end(data)
  })
  const revision = upload.id.toString()
  return { size: data.byteLength, fingerprint: revision, revision }
}

async function deleteFile(conn: GridFSAccessor, key: string): Promise<void> {
  // Removes every revision of the filename (rm semantics; mirrors S3's
  // DeleteObject, which also succeeds silently on a missing key).
  await deleteAll(conn, { filename: key })
}

async function deletePrefix(conn: GridFSAccessor, pfx: string): Promise<void> {
  await deleteAll(conn, prefixQuery(pfx))
}

async function copyFile(conn: GridFSAccessor, srcKey: string, dstKey: string): Promise<boolean> {
  // Copies the latest revision only (mirrors S3 CopyObject), streamed so
  // large files never buffer fully in memory.
  const doc = await latestFile(conn, srcKey)
  if (doc === null) return false
  const b = await bucket(conn)
  const readable = b.openDownloadStream(doc._id)
  const upload = b.openUploadStream(dstKey)
  await new Promise<void>((resolve, reject) => {
    upload.on('error', reject)
    readable.on('error', reject)
    upload.on('finish', () => {
      resolve()
    })
    readable.pipe(upload)
  })
  return true
}

async function moveFile(conn: GridFSAccessor, srcKey: string, dstKey: string): Promise<boolean> {
  // Server-side: retag every revision's filename instead of copying
  // bytes, so the whole revision history moves with the file.
  if ((await latestFile(conn, srcKey)) === null) return false
  if (dstKey !== srcKey) {
    await deleteAll(conn, { filename: dstKey })
  }
  const files = await filesColl(conn)
  await files.updateMany({ filename: srcKey }, { $set: { filename: dstKey } })
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
  const files = await filesColl(conn)
  const docs: { _id: ObjectId; filename: string }[] = []
  for await (const doc of files.find(prefixQuery(srcPfx), {
    projection: { _id: 1, filename: 1 },
  })) {
    docs.push({ _id: doc._id, filename: doc.filename as string })
  }
  if (docs.length === 0) return false
  if (dstPfx !== srcPfx) {
    // Read the source docs before clearing the destination: on a
    // self-directed move the two queries select the same revisions, and
    // deleting first would drop what the retag is about to move.
    await deleteAll(conn, prefixQuery(dstPfx))
  }
  for (const doc of docs) {
    await files.updateOne(
      { _id: doc._id },
      { $set: { filename: `${dstPfx}${doc.filename.slice(srcPfx.length)}` } },
    )
  }
  return true
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
  listTree,
  listSubtree,
  head,
  get,
  put,
  deleteFile,
  deletePrefix,
  moveFile,
  movePrefix,
  copyFile,
  probePrefix,
  isNotFound: isNoFileError,
  findTree,
}
