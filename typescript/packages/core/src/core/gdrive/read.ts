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
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { PathSpec } from '../../types.ts'
import { record, recordingActive, revisionFor, startOp } from '../../observe/context.ts'
import { readDoc } from '../gdocs/read.ts'
import { downloadFile } from '../google/drive.ts'
import { captureFileMetadata, downloadRevision } from './versions.ts'
import { readSpreadsheet } from '../gsheets/read.ts'
import { readPresentation } from '../gslides/read.ts'
import type { TokenManager } from '../google/client.ts'
import { driveFingerprint, entryFingerprint } from './fingerprint.ts'
import { md5HexAsync } from '../../utils/hash.ts'
import { DIRECTORY_RESOURCE_TYPES, NATIVE_RESOURCE_TYPES, readdir } from './readdir.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { sliceWindow, windowFor } from '../../utils/ranges.ts'

// Whether a read returned the whole object rather than a window. A token
// describes the whole object, so a window stamped with one would read as
// fresh for the life of the entry.
function wholeFile(offset: number, size: number | null): boolean {
  return offset === 0 && size === null
}

// Whether Drive's md5 names other bytes than the ones just read. The metadata
// and the download are two requests, so a write between them leaves metadata
// that predates the bytes.
async function staleMd5(md5: unknown, data: Uint8Array): Promise<boolean> {
  return typeof md5 === 'string' && md5 !== '' && (await md5HexAsync(data)) !== md5
}

// Download a binary file honouring snapshot revision pins. A pinned path
// reads that revision's content. Otherwise the token comes from a capture when
// a recorder is bound and from the index entry when none is, so it never
// depends on the recorder; the entry's revision is not pinned, since it can be
// a TTL old. Either md5 is checked against the bytes, and a stale one drops
// the token and the revision with it.
export async function readFileVersioned(
  tm: TokenManager,
  fileId: string,
  virtual: string,
  entry: IndexEntry,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const pinned = revisionFor(virtual)
  const window = windowFor(offset, size)
  const whole = wholeFile(offset, size)
  const timer = startOp()
  let fingerprint: string | null = null
  let revision: string | null = pinned
  let data: Uint8Array
  if (pinned !== null) {
    data = await downloadRevision(tm, fileId, pinned, window)
  } else if (recordingActive()) {
    const [md5, captured] = await captureFileMetadata(tm, fileId)
    revision = captured
    data = await downloadFile(tm, fileId, window)
    if (whole && (await staleMd5(md5, data))) revision = null
    else if (whole)
      fingerprint = driveFingerprint(entry.resourceType, md5, revision, entry.remoteTime)
  } else {
    data = await downloadFile(tm, fileId, window)
    if (whole && !(await staleMd5(entry.extra.md5_checksum, data)))
      fingerprint = entryFingerprint(entry)
  }
  record('read', virtual, 'gdrive', data.length, timer, { fingerprint, revision })
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
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const key = path.vfsPath
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
  if (!NATIVE_RESOURCE_TYPES.has(rt))
    return readFileVersioned(accessor.tokenManager, entry.id, path.virtual, entry, offset, size)
  const timer = startOp()
  let rendered: Uint8Array
  if (rt === 'gdrive/gdoc') rendered = await readDoc(accessor.tokenManager, entry.id)
  else if (rt === 'gdrive/gsheet') rendered = await readSpreadsheet(accessor.tokenManager, entry.id)
  else rendered = await readPresentation(accessor.tokenManager, entry.id)
  const sliced = sliceWindow(rendered, offset, size)
  // No revision: a pin would replace the drift check a render relies on.
  record('read', path.virtual, 'gdrive', sliced.length, timer, {
    fingerprint: wholeFile(offset, size) ? entryFingerprint(entry) : null,
    revision: null,
  })
  return sliced
}

export async function* readStream(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}
