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
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record, revisionFor, startOp } from '@struktoai/mirage-core/observe/context'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { bucket, fileById, gridfsKey, latestFile, loadGridFSModule, rawPathOf } from './client.ts'

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

// The window the driver will accept for a file of `length` bytes, or null
// when it is empty. The node driver validates a window against the stored
// length and refuses every POSIX-shaped answer: a start past the end, an end
// past the end, and even an omitted end, which it defaults to 0 and then
// reads as ending before the start. A POSIX read does none of that, it just
// comes back short, so the window is clamped to the file here. Python needs
// no equivalent: its driver reads through a file object that seeks and stops
// at EOF like any file.
function clampWindow(
  length: number,
  options: GridFSReadOptions,
): { start: number; end: number } | null {
  const start = Math.min(options.offset ?? 0, length)
  const end = options.size === undefined ? length : Math.min(start + options.size, length)
  return start >= end ? null : { start, end }
}

async function downloadBytes(
  accessor: GridFSAccessor,
  path: PathSpec,
  fileId: ObjectId,
  options: GridFSReadOptions = {},
): Promise<Uint8Array> {
  const b = await bucket(accessor)
  const windowed = (options.offset ?? 0) !== 0 || options.size !== undefined
  let streamOptions: { start: number; end: number } | undefined
  if (windowed) {
    const doc = await fileById(accessor, fileId)
    if (doc === null) throw enoent(path)
    const window = clampWindow(doc.length, options)
    if (window === null) return new Uint8Array(0)
    streamOptions = window
  }
  const readable = b.openDownloadStream(fileId, streamOptions)
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
  const timer = startOp()
  const fileId = await resolveFileId(accessor, path, key)
  const bytes = await downloadBytes(accessor, path, fileId, options)
  const revision = fileId.toString()
  record('read', virtual, ResourceName.GRIDFS, bytes.byteLength, timer, {
    fingerprint: revision,
    revision,
  })
  return bytes
}
