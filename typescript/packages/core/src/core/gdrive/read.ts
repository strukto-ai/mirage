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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import {
  record,
  recordStream,
  recordingActive,
  revisionFor,
  startOp,
} from '../../observe/context.ts'
import { readDoc } from '../gdocs/read.ts'
import { downloadFile, downloadFileStream } from '../google/drive.ts'
import { captureFileMetadata, downloadRevision, downloadRevisionStream } from './versions.ts'
import { readSpreadsheet } from '../gsheets/read.ts'
import { readPresentation } from '../gslides/read.ts'
import type { TokenManager } from '../google/client.ts'
import { NATIVE_RESOURCE_TYPES, driveFingerprint } from './fingerprint.ts'
import { Md5, md5HexAsync } from '../../utils/hash.ts'
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
// a recorder is bound and from the listed row when none is, so it never
// depends on the recorder; the row's revision is not pinned, since it can be a
// TTL old. Either md5 is checked against the bytes, and a stale one drops the
// token and the revision with it.
export async function readFileVersioned(
  tm: TokenManager,
  fileId: string,
  virtual: string,
  entry: FileStat,
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
      fingerprint = driveFingerprint(
        entry.extra.resource_type as string,
        md5,
        revision,
        entry.modified,
      )
  } else {
    data = await downloadFile(tm, fileId, window)
    if (whole && !(await staleMd5(entry.extra.md5_checksum, data))) fingerprint = entry.fingerprint
  }
  record('read', virtual, 'gdrive', data.length, timer, { fingerprint, revision })
  return data
}

/**
 * What is at the file `path`, as its parent's listing named it. Rejects
 * ENOENT when nothing is there and EISDIR when a folder is. Mirrors Python's
 * `file_entry`.
 */
export function fileEntry(path: PathSpec, entry: FileStat | null | undefined): FileStat {
  if (entry === null || entry === undefined) throw enoent(path.virtual)
  if (entry.type === FileType.DIRECTORY) throw eisdir(path.virtual)
  return entry
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
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 *   entry: what is at the path.
 */
export async function read(
  accessor: GDriveAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
  entry?: FileStat | null,
): Promise<Uint8Array> {
  const offset = options?.offset ?? 0
  const size = options?.size ?? null
  const found = fileEntry(path, entry)
  const fileId = found.extra.file_id as string
  const rt = found.extra.resource_type as string
  if (!NATIVE_RESOURCE_TYPES.has(rt))
    return readFileVersioned(accessor.tokenManager, fileId, path.virtual, found, offset, size)
  const timer = startOp()
  let rendered: Uint8Array
  if (rt === 'gdrive/gdoc') rendered = await readDoc(accessor.tokenManager, fileId)
  else if (rt === 'gdrive/gsheet') rendered = await readSpreadsheet(accessor.tokenManager, fileId)
  else rendered = await readPresentation(accessor.tokenManager, fileId)
  const sliced = sliceWindow(rendered, offset, size)
  // No revision: a pin would replace the drift check a render relies on.
  record('read', path.virtual, 'gdrive', sliced.length, timer, {
    fingerprint: wholeFile(offset, size) ? found.fingerprint : null,
    revision: null,
  })
  return sliced
}

/**
 * Stream a Drive file as it downloads. A google-apps file exists only once
 * rendered, so it comes in one chunk, as `read` gives it. A binary file is
 * stamped as `readFileVersioned` stamps a whole read, once the last chunk is
 * in and checked against the md5 Drive gave: a stream abandoned part-way
 * stamps nothing. Mirrors Python's `read_stream`.
 */
export async function* readStream(
  accessor: GDriveAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): AsyncGenerator<Uint8Array, void> {
  const found = fileEntry(path, entry)
  const fileId = found.extra.file_id as string
  if (NATIVE_RESOURCE_TYPES.has(found.extra.resource_type as string)) {
    yield await read(accessor, path, undefined, found)
    return
  }
  const tm = accessor.tokenManager
  const pinned = revisionFor(path.virtual)
  const rec = recordStream('read', path.virtual, 'gdrive', { revision: pinned })
  let md5: string | null = null
  let revision: string | null = null
  let chunks: AsyncGenerator<Uint8Array, void>
  if (pinned !== null) {
    chunks = downloadRevisionStream(tm, fileId, pinned)
  } else {
    if (rec !== null) [md5, revision] = await captureFileMetadata(tm, fileId)
    chunks = downloadFileStream(tm, fileId)
  }
  const digest = md5 !== null && md5 !== '' ? new Md5() : null
  for await (const chunk of chunks) {
    digest?.update(chunk)
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }
  if (rec === null || pinned !== null) return
  if (digest !== null && digest.digest() !== md5) return
  rec.revision = revision
  rec.fingerprint = driveFingerprint(
    found.extra.resource_type as string,
    md5,
    revision,
    found.modified,
  )
}
