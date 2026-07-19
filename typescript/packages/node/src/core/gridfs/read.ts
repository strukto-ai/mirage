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

import type { ObjectId } from 'mongodb'
import {
  ResourceName,
  enoent,
  record,
  revisionFor,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { bucket, gridfsKey, latestFile, loadGridFSModule, rawPathOf } from './_client.ts'

export interface GridFSReadOptions {
  offset?: number
  size?: number
}

export async function resolveFileId(
  accessor: GridFSAccessor,
  path: PathSpec,
  key: string,
): Promise<ObjectId> {
  const pinnedRevision = revisionFor(path.virtual)
  if (pinnedRevision !== null) {
    const mod = await loadGridFSModule()
    const objectIdCtor = (mod as unknown as { ObjectId: new (id: string) => ObjectId }).ObjectId
    return new objectIdCtor(pinnedRevision)
  }
  const doc = await latestFile(accessor, key)
  if (doc === null) throw enoent(path)
  return doc._id
}

export async function downloadBytes(
  accessor: GridFSAccessor,
  path: PathSpec,
  fileId: ObjectId,
  options: GridFSReadOptions = {},
): Promise<Uint8Array> {
  const b = await bucket(accessor)
  const streamOptions: { start?: number; end?: number } = {}
  if (options.offset !== undefined && options.offset !== 0) {
    streamOptions.start = options.offset
  }
  if (options.size !== undefined) {
    streamOptions.end = (options.offset ?? 0) + options.size
  }
  const readable = b.openDownloadStream(
    fileId,
    Object.keys(streamOptions).length > 0 ? streamOptions : undefined,
  )
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of readable as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT' || isNoFileError(err)) {
      throw enoent(path)
    }
    throw err
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export function isNoFileError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const message = (err as { message?: string }).message ?? ''
  return message.includes('FileNotFound')
}

export async function read(
  accessor: GridFSAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options: GridFSReadOptions = {},
): Promise<Uint8Array> {
  const virtual = path.virtual
  const raw = rawPathOf(path)
  const key = gridfsKey(raw, accessor.config)
  const startMs = performance.now()
  const fileId = await resolveFileId(accessor, path, key)
  const bytes = await downloadBytes(accessor, path, fileId, options)
  const revision = fileId.toString()
  record('read', virtual, ResourceName.GRIDFS, bytes.byteLength, startMs, {
    fingerprint: revision,
    revision,
  })
  return bytes
}
