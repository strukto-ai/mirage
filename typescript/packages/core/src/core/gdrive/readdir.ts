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
import { DirListing, FileStat, FileType, type PathSpec } from '../../types.ts'
import {
  type DriveFile,
  FOLDER_MIME,
  MIME_TO_EXT,
  listFiles,
  listSharedDrives,
} from '../google/drive.ts'
import { driveFingerprint } from './fingerprint.ts'
import { rootContext } from './resolve.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { enotdir, enoent } from '../../errors/fs.ts'

const RESOURCE_TYPES: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.folder': 'gdrive/folder',
  'application/vnd.google-apps.document': 'gdrive/gdoc',
  'application/vnd.google-apps.spreadsheet': 'gdrive/gsheet',
  'application/vnd.google-apps.presentation': 'gdrive/gslide',
}

export function resourceTypeFor(mime: string): string {
  return RESOURCE_TYPES[mime] ?? 'gdrive/file'
}

export function uniqueSharedDriveName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name
  let filename = `${name} [Shared Drive]`
  let suffix = 2
  while (existingNames.has(filename)) {
    filename = `${name} [Shared Drive ${String(suffix)}]`
    suffix += 1
  }
  return filename
}

/**
 * The stat of one Drive file resource, as a listing, `files.get` or an
 * upload's reply returns it.
 *
 * Pure, so an upload's reply parses the same as a stat. A missing `mimeType`
 * reads as a plain file: natives are refused before any upload, so a reply
 * without one names bytes. `extra` carries what the functions handed the stat
 * act on: the file id, its shared drive, its MIME type, and the md5 and head
 * revision a read checks. Mirrors Python's `stat_from_item`.
 *
 * @param item a Drive file resource with `ITEM_FIELDS`
 */
export function statFromItem(item: DriveFile): FileStat {
  const mime = item.mimeType ?? ''
  const modified = item.modifiedTime ?? ''
  const extra: Record<string, unknown> = { file_id: item.id, mime_type: mime }
  if (item.driveId !== undefined && item.driveId !== '') extra.drive_id = item.driveId
  if (mime === FOLDER_MIME) {
    return new FileStat({ name: item.name, type: FileType.DIRECTORY, modified, extra })
  }
  const resourceType = resourceTypeFor(mime)
  const ext = MIME_TO_EXT[mime]
  const vfsName = ext !== undefined ? `${item.name}${ext}` : item.name
  if (typeof item.md5Checksum === 'string' && item.md5Checksum !== '') {
    extra.md5_checksum = item.md5Checksum
  }
  if (typeof item.headRevisionId === 'string' && item.headRevisionId !== '') {
    extra.head_revision_id = item.headRevisionId
  }
  // Binary files download raw, so Drive's size is the rendered byte length.
  // Google-apps files render to JSON, so Drive's source size must not become
  // FileStat.size (see the CLAUDE.md FUSE rules); it lives in extra instead.
  const sourceSize = Number.parseInt(item.size ?? item.quotaBytesUsed ?? '0', 10)
  if (ext !== undefined && Number.isFinite(sourceSize) && sourceSize > 0) {
    extra.source_size = sourceSize
  }
  const size = ext === undefined && item.size !== undefined ? parseInt(item.size, 10) : null
  return new FileStat({
    name: vfsName,
    size,
    type: FileType.FILE,
    content: contentTypeForPath(vfsName),
    modified,
    fingerprint: driveFingerprint(resourceType, item.md5Checksum, item.headRevisionId, modified),
    extra: { ...extra, resource_type: resourceType },
  })
}

/**
 * A folder's children, each as `stat` answers it. The mount root lists the
 * scoped folder, or My Drive and the Shared Drives the account sees; any
 * other folder is listed by the id its parent's listing named.
 */
export async function readdir(
  accessor: GDriveAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): Promise<FileStat[] | DirListing> {
  const target = path.pattern !== null ? path.dir : path
  const atRoot = target.vfsPath.replace(/^\/+|\/+$/g, '') === ''
  let folderId: string
  let driveId: string | null = null
  if (atRoot) {
    ;[folderId, driveId] = await rootContext(accessor)
  } else if (entry === null || entry === undefined) {
    throw enoent(path.virtual)
  } else if (entry.type !== FileType.DIRECTORY) {
    // Listing a file's id answers with an empty child set rather than an
    // error, so the listing that named it decides: opendir(2) says ENOTDIR
    // for `ls /data/a.txt/x`.
    throw enotdir(path.virtual)
  } else {
    folderId = entry.extra.file_id as string
    const entryDriveId = entry.extra.drive_id
    driveId = typeof entryDriveId === 'string' ? entryDriveId : null
  }
  const files = await listFiles(accessor.tokenManager, { folderId, driveId })
  const rows = files.map((f) => statFromItem(f))
  let complete = true
  if (atRoot && folderId === 'root') {
    // Shared Drive enumeration is best-effort: if the account can't list
    // them (missing scope, API error), still return My Drive contents.
    // A folder-scoped mount lists only the folder's children, so shared
    // drives never surface there.
    let sharedDrives: { id: string; name: string }[] = []
    try {
      sharedDrives = await listSharedDrives(accessor.tokenManager)
    } catch {
      sharedDrives = []
      complete = false
    }
    const existingNames = new Set(rows.map((row) => row.name))
    for (const d of sharedDrives) {
      const filename = uniqueSharedDriveName(d.name, existingNames)
      existingNames.add(filename)
      rows.push(
        new FileStat({
          name: filename,
          type: FileType.DIRECTORY,
          extra: {
            file_id: d.id,
            mime_type: FOLDER_MIME,
            drive_id: d.id,
            resource_type: 'gdrive/shared_drive',
          },
        }),
      )
    }
  }
  // Deterministic vfs order: glob expansion and walkers follow readdir
  // order, so sort by rendered filename (Drive returns modifiedTime desc).
  // Codepoint compare, not localeCompare: python sorts by codepoint and the
  // two runners must list identically.
  rows.sort((a, b) => compareCodePoints(a.name, b.name))
  // A root whose Shared Drives could not be listed is short: kept as rows,
  // it would pin a My-Drive-only root as the whole listing until it
  // expired, hiding Shared Drives after the cause clears.
  return complete ? rows : new DirListing({ entries: rows, partial: true })
}
