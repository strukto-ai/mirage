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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { PathSpec } from '../../types.ts'
import { record, recordingActive, revisionFor, startOp } from '../../observe/context.ts'
import { readDoc } from '../gdocs/read.ts'
import { readSpreadsheet } from '../gsheets/read.ts'
import { readPresentation } from '../gslides/read.ts'
import type { DriveApi } from './api.ts'
import { DIRECTORY_RESOURCE_TYPES, readdir } from './readdir.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { sliceWindow, windowFor } from '../../utils/ranges.ts'

// Download a binary file honouring snapshot revision pins. A pinned path
// reads that revision's content; an actively recorded read captures
// (fingerprint, revision) so snapshots can pin it later, mirroring the
// msgraph read_item.
export async function readFileVersioned(
  drive: DriveApi,
  fileId: string,
  virtual: string,
  label: string,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const pinned = revisionFor(virtual)
  const window = windowFor(offset, size)
  const timer = startOp()
  let fingerprint: string | null = null
  let revision: string | null = pinned
  let data: Uint8Array
  if (pinned !== null) {
    data = await drive.downloadRevision(fileId, pinned, window)
  } else if (recordingActive()) {
    ;[fingerprint, revision] = await drive.captureFileMetadata(fileId)
    data = await drive.downloadFile(fileId, window)
  } else {
    data = await drive.downloadFile(fileId, window)
  }
  record('read', label, 'gdrive', data.length, timer, { fingerprint, revision })
  return data
}

/**
 * Read a Drive file, optionally only a byte range of it.
 *
 * Only a binary file has a remote range to ask for. A google-apps file
 * is rendered here into JSON, so its bytes do not exist until we make
 * them and the window can only be taken afterwards.
 *
 * Args:
 *   accessor: Drive accessor.
 *   path: the path to read.
 *   index: listing cache, consulted for the file id.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const offset = options?.offset ?? 0
  const size = options?.size ?? null
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  const entry = await entryOrWarm(
    index,
    virtualKey,
    parentKey !== virtualKey
      ? () => readdir(accessor, PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)), index)
      : null,
  )
  if (entry === null) throw enoent(path.virtual)
  const rt = entry.resourceType
  if (DIRECTORY_RESOURCE_TYPES.has(rt)) throw eisdir(path.virtual)
  if (rt === 'gdrive/gdoc')
    return sliceWindow(await readDoc(accessor.tokenManager, entry.id), offset, size)
  if (rt === 'gdrive/gsheet')
    return sliceWindow(await readSpreadsheet(accessor.tokenManager, entry.id), offset, size)
  if (rt === 'gdrive/gslide')
    return sliceWindow(await readPresentation(accessor.tokenManager, entry.id), offset, size)
  return readFileVersioned(accessor.drive, entry.id, path.virtual, key, offset, size)
}

export async function* stream(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}
