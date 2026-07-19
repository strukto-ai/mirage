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
import { PathSpec } from '../../types.ts'
import { record, recordingActive, revisionFor } from '../../observe/context.ts'
import { readDoc } from '../gdocs/read.ts'
import { downloadFile } from '../google/drive.ts'
import { captureFileMetadata, downloadRevision } from './versions.ts'
import { readSpreadsheet } from '../gsheets/read.ts'
import { readPresentation } from '../gslides/read.ts'
import type { TokenManager } from '../google/_client.ts'
import { DIRECTORY_RESOURCE_TYPES, readdir } from './readdir.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

function eisdir(p: string): Error {
  const e = new Error(`EISDIR: ${p}`) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

export async function readBytes(tm: TokenManager, fileId: string): Promise<Uint8Array> {
  return downloadFile(tm, fileId)
}

// Download a binary file honouring snapshot revision pins. A pinned path
// reads that revision's content; an actively recorded read captures
// (fingerprint, revision) so snapshots can pin it later, mirroring the
// msgraph read_item.
export async function readFileVersioned(
  tm: TokenManager,
  fileId: string,
  virtual: string,
  label: string,
): Promise<Uint8Array> {
  const pinned = revisionFor(virtual)
  const startMs = performance.now()
  let fingerprint: string | null = null
  let revision: string | null = pinned
  let data: Uint8Array
  if (pinned !== null) {
    data = await downloadRevision(tm, fileId, pinned)
  } else if (recordingActive()) {
    ;[fingerprint, revision] = await captureFileMetadata(tm, fileId)
    data = await downloadFile(tm, fileId)
  } else {
    data = await downloadFile(tm, fileId)
  }
  record('read', label, 'gdrive', data.length, startMs, { fingerprint, revision })
  return data
}

export async function read(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    // cold index: list the parent directory to populate the entry, then retry
    const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
    if (parentKey !== virtualKey) {
      const parentPath = PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix))
      try {
        await readdir(accessor, parentPath, index)
        result = await index.get(virtualKey)
      } catch {
        // parent refresh failed; fall through to ENOENT
      }
    }
    if (result.entry === undefined || result.entry === null) throw enoent(path.virtual)
  }
  const rt = result.entry.resourceType
  if (DIRECTORY_RESOURCE_TYPES.has(rt)) throw eisdir(path.virtual)
  if (rt === 'gdrive/gdoc') return readDoc(accessor.tokenManager, result.entry.id)
  if (rt === 'gdrive/gsheet') return readSpreadsheet(accessor.tokenManager, result.entry.id)
  if (rt === 'gdrive/gslide') return readPresentation(accessor.tokenManager, result.entry.id)
  return readFileVersioned(accessor.tokenManager, result.entry.id, path.virtual, key)
}

export async function* stream(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}
