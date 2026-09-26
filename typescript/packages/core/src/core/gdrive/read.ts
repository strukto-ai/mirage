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
import { driveFingerprint } from './fingerprint.ts'
import { md5HexAsync } from '../../utils/hash.ts'
import { DIRECTORY_RESOURCE_TYPES, readdir } from './readdir.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../utils/errors.ts'
import { sliceWindow, windowFor } from '../../utils/ranges.ts'

const NATIVE_RESOURCE_TYPES = new Set(['gdrive/gdoc', 'gdrive/gsheet', 'gdrive/gslide'])

// Whether a read returned the entire object rather than a window. A token
// describes the whole object, and latestFingerprint's byte-identity guard
// applies only to writes, so a windowed body stamped with one would read as
// fresh for the life of the entry. Both read paths ask this before stamping;
// a guard written twice is a guard the two paths can drift apart on.
function wholeFile(offset: number, size: number | null): boolean {
  return offset === 0 && size === null
}

// The [fingerprint, revision] pair that describes bytes we just read.
//
// The capture and the download are two separate requests, so the metadata
// describes the object as of the first and the bytes come from the second.
// Drive's md5Checksum is the md5 of the content and the content is already in
// memory, so the two are compared rather than trusted -- no extra request.
//
// The three answers are three different states of evidence, and they are not
// interchangeable:
//
//   - A window proves nothing about either token. The fingerprint is dropped
//     because it describes the whole object and a partial body under it would
//     read as fresh for the life of the entry, but the revision still names
//     the object the window came from, so it stays.
//   - A disagreeing md5 is positive proof that the capture predates these
//     bytes -- and the revision came from that same capture, so it describes
//     the old content too. Both are dropped. Keeping the revision would be
//     worse than useless: a revision pin REPLACES the drift check rather than
//     supplementing it, so replay would serve the pre-change bytes and report
//     success with the one mechanism that would have surfaced it switched off.
//   - Otherwise the capture is trusted. A capture with no md5 cannot be
//     checked, so its token is stamped as it arrived -- dropping it would
//     leave the read at null against stat's head revision, the mismatch this
//     chain exists to remove.
async function verifiedTokens(
  md5: string | null,
  headRevision: string | null,
  modified: string | null,
  data: Uint8Array,
  offset: number,
  size: number | null,
): Promise<[string | null, string | null]> {
  if (!wholeFile(offset, size)) return [null, headRevision]
  if (md5 !== null && (await md5HexAsync(data)) !== md5) return [null, null]
  return [driveFingerprint(md5, headRevision, modified), headRevision]
}

// One version field off an index entry, or null when it is unusable.
// `IndexEntry.extra` is untyped: a listing that omitted the field leaves it
// absent, and a restored index can hold an empty string or a non-string. Any
// of those reaching the md5 comparison would drop a token the next link of
// the chain could have stamped.
function entryToken(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

// Download a binary file honouring snapshot revision pins. A pinned path
// reads that revision's content; an actively recorded read captures the
// version fields and verifies the md5 against the bytes it downloaded.
//
// An unrecorded read stamps from the index entry the caller resolved the file
// through, checked the same way, so its token does not depend on a recorder
// being bound and costs no request. The entry precedes the download, so a
// stale md5 is caught by the check; the other two fields are unverified and
// trusted, as an md5-less capture is. It pins no revision: the entry's can be
// a TTL old, and a replay pinned to it could serve bytes this read never saw.
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
  const timer = startOp()
  let fingerprint: string | null = null
  let revision: string | null = pinned
  let data: Uint8Array
  if (pinned !== null) {
    data = await downloadRevision(tm, fileId, pinned, window)
  } else if (recordingActive()) {
    const [md5, captured, modified] = await captureFileMetadata(tm, fileId)
    revision = captured
    data = await downloadFile(tm, fileId, window)
    ;[fingerprint, revision] = await verifiedTokens(md5, captured, modified, data, offset, size)
  } else {
    data = await downloadFile(tm, fileId, window)
    ;[fingerprint] = await verifiedTokens(
      entryToken(entry.extra.md5_checksum),
      entryToken(entry.extra.head_revision_id),
      entryToken(entry.remoteTime),
      data,
      offset,
      size,
    )
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
  // The entry's token costs no request and is never newer than the render. It
  // can be a TTL older: a wasted refetch, or a STRICT drift raise on an
  // untouched file. No revision: a pin would replace the drift check, and this
  // branch never consults one.
  record('read', path.virtual, 'gdrive', sliced.length, timer, {
    fingerprint: wholeFile(offset, size)
      ? driveFingerprint(entry.extra.md5_checksum, entry.extra.head_revision_id, entry.remoteTime)
      : null,
    revision: null,
  })
  return sliced
}

export async function* stream(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}
