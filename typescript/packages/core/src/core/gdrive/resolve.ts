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
import { eacces, enoent, enotdir } from '../../errors/fs.ts'
import { GoogleApiError } from '../google/client.ts'
import { FOLDER_MIME, MIME_TO_EXT } from '../google/drive.ts'
import type { DriveFile } from '../google/drive.ts'
import { stripSlash } from '../../utils/slash.ts'

// A resolved Drive item: enough identity to mutate it.
export interface DriveNode {
  id: string
  name: string
  mimeType: string
  driveId: string | null
}

const ROOT_DRIVE_IDS = new WeakMap<GDriveAccessor, string | null>()

// The mount root's [folder id, shared drive id]. An unscoped mount roots at
// My Drive. A folderId scope may point inside a Shared Drive (or be a Shared
// Drive id itself); its driveId is fetched once via files.get and memoized
// per accessor, so every listing and resolution under the root queries the
// right corpus.
export async function rootContext(accessor: GDriveAccessor): Promise<[string, string | null]> {
  const folderId = accessor.tokenManager.config.folderId
  if (folderId === undefined || folderId === '') return ['root', null]
  if (!ROOT_DRIVE_IDS.has(accessor)) {
    const item = await accessor.drive.getFile(folderId)
    ROOT_DRIVE_IDS.set(accessor, item.driveId ?? null)
  }
  return [folderId, ROOT_DRIVE_IDS.get(accessor) ?? null]
}

// Map a Drive HTTP 403 during a mutation to EACCES. Drive access is per-item
// (shared-drive roles, folder-level grants), so a write-mode mount can still
// hold items the user may not edit; a denied mutation surfaces as Permission
// denied on the operand, like a real filesystem.
export function eaccesOnDenied<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args)
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 403) {
        const spec = args.find(
          (a): a is PathSpec => typeof a === 'object' && a !== null && 'virtual' in a,
        )
        throw eacces(spec ?? '')
      }
      throw err
    }
  }
}

export function isFolder(node: DriveNode): boolean {
  return node.mimeType === FOLDER_MIME
}

// Destination Drive name for moving/copying an item to a vfs basename: a
// google-native file's Drive name has no rendered suffix, so the suffix
// matching the item's MIME type is stripped.
export function driveTargetName(basename: string, mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType]
  if (ext !== undefined && basename.endsWith(ext) && basename.length > ext.length) {
    return basename.slice(0, -ext.length)
  }
  return basename
}

export function nodeFromItem(item: DriveFile, driveId: string | null): DriveNode {
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType ?? '',
    driveId: item.driveId ?? driveId,
  }
}

/** The Drive item a listed row names. Mirrors Python's `node_of`. */
export function nodeOf(row: FileStat): DriveNode {
  const driveId = row.extra.drive_id
  const mimeType = row.extra.mime_type
  return {
    id: row.extra.file_id as string,
    name: row.name,
    mimeType: typeof mimeType === 'string' ? mimeType : '',
    driveId: typeof driveId === 'string' ? driveId : null,
  }
}

/**
 * The folder a create at `path` lands in: the mount root's, or what is at the
 * parent path. A missing or non-directory parent names the operand, as
 * mkdir(2) does. Answers [parent folder id, shared drive id | null]. Mirrors
 * Python's `parent_folder`.
 */
export async function parentFolder(
  accessor: GDriveAccessor,
  path: PathSpec,
  parent: FileStat | null | undefined,
): Promise<[string, string | null]> {
  if (!stripSlash(path.vfsPath).includes('/')) return rootContext(accessor)
  if (parent === null || parent === undefined) throw enoent(path.virtual)
  if (parent.type !== FileType.DIRECTORY) throw enotdir(path.virtual)
  const driveId = parent.extra.drive_id
  return [parent.extra.file_id as string, typeof driveId === 'string' ? driveId : null]
}
