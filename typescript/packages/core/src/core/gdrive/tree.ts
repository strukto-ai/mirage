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
import { DirListing, type FileStat, FileType, type PathSpec } from '../../types.ts'
import { GoogleApiError } from '../google/client.ts'
import type { DriveFile } from '../google/drive.ts'
import { FOLDER_MIME, MIME_TO_EXT, listChildren } from '../google/drive.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { readdir, statFromItem } from './readdir.ts'

export const PARENTS_PER_QUERY = 40

// The rendered vfs filename for a Drive item.
function vfsName(item: DriveFile): string {
  const ext = MIME_TO_EXT[item.mimeType ?? '']
  return ext !== undefined ? `${item.name}${ext}` : item.name
}

// Walk the subtree of the folder `folderId` (in shared drive `driveId`) at
// `path`, yielding [mount-relative path, item, isDir]. The walk goes a level
// at a time, the level's folders listed together (`listLevel`). Children are
// visited in vfs-name order so every traversal-based command (find, du) is
// deterministic, mirroring the python iter_tree contract.
export async function* iterTree(
  accessor: GDriveAccessor,
  path: PathSpec,
  folderId: string,
  driveId: string | null,
): AsyncIterable<[string, DriveFile, boolean]> {
  let level: [string, string, string | null][] = [[path.vfsPath, folderId, driveId]]
  while (level.length > 0) {
    const children = await listLevel(
      accessor,
      level.map(([, fid, did]) => [fid, did] as const),
    )
    const below: [string, string, string | null][] = []
    for (const [rel, fid, did] of level) {
      const items = [...(children.get(fid) ?? [])].sort((a, b) =>
        compareCodePoints(vfsName(a), vfsName(b)),
      )
      for (const item of items) {
        const name = vfsName(item)
        const childRel = rel !== '' ? `${rel}/${name}` : name
        const isDir = item.mimeType === FOLDER_MIME
        yield [childRel, item, isDir]
        if (isDir) below.push([childRel, item.id, item.driveId ?? did])
      }
    }
    level = below
  }
}

/**
 * The children of each folder of one level of a walk, by folder id.
 *
 * One query asks for the children of up to `PARENTS_PER_QUERY` folders of one
 * corpus, where a walk lists each folder on its own, and each child is filed
 * under every folder asked about that its `parents` name. A folder asked about
 * alone takes every child, so `root`, the alias Drive names My Drive by, lists
 * too. Mirrors Python's `list_level`.
 */
export async function listLevel(
  accessor: GDriveAccessor,
  folders: readonly (readonly [string, string | null])[],
): Promise<Map<string, DriveFile[]>> {
  const corpora = new Map<string | null, string[]>()
  const children = new Map<string, DriveFile[]>()
  for (const [folderId, driveId] of folders) {
    const ids = corpora.get(driveId) ?? []
    ids.push(folderId)
    corpora.set(driveId, ids)
    children.set(folderId, [])
  }
  for (const [driveId, ids] of corpora) {
    for (let start = 0; start < ids.length; start += PARENTS_PER_QUERY) {
      const asked = ids.slice(start, start + PARENTS_PER_QUERY)
      for (const item of await listChildren(accessor.tokenManager, asked, driveId)) {
        const filed =
          asked.length === 1 ? asked : (item.parents ?? []).filter((p) => asked.includes(p))
        for (const parent of filed) children.get(parent)?.push(item)
      }
    }
  }
  return children
}

/**
 * Every item under a folder, each as its folder's listing renders it, read a
 * level at a time (`listLevel`): a query per level and corpus where a walk
 * sends a listing per folder.
 *
 * The folder's own children are its listing, so the mount root keeps its
 * Shared Drives and a folder that is not there raises what a listing raises.
 * Of two items with one name in a folder, the one its listing keeps, the last,
 * stands. Null when that listing is short (Shared Drives it could not list),
 * or when a level below it fails, so the walk lists what is there and reports,
 * or skips, each folder on its own. Mirrors Python's `tree`.
 */
export async function tree(
  accessor: GDriveAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): Promise<Map<string, FileStat> | null> {
  const listed = await readdir(accessor, path, entry)
  if (listed instanceof DirListing) return null
  const found = new Map<string, FileStat>()
  let level = placed(found, '', listed, null)
  while (level.size > 0) {
    let children: Map<string, DriveFile[]>
    try {
      children = await listLevel(accessor, [...level.values()])
    } catch (err) {
      const failed =
        err instanceof GoogleApiError || err instanceof TypeError || err instanceof DOMException
      if (!failed) throw err
      console.debug(`drive tree of ${path.virtual} left to the walk: ${String(err)}`)
      return null
    }
    const below = new Map<string, [string, string | null]>()
    for (const [rel, [folderId, driveId]] of level) {
      const rows = (children.get(folderId) ?? [])
        .map(statFromItem)
        .sort((a, b) => compareCodePoints(a.name, b.name))
      for (const [key, folder] of placed(found, rel, rows, driveId)) below.set(key, folder)
    }
    level = below
  }
  return found
}

/**
 * Put a folder's rows into a tree read, and answer the folders among them by
 * path, each with its id and shared drive. Mirrors Python's `_placed`.
 */
function placed(
  found: Map<string, FileStat>,
  rel: string,
  rows: readonly FileStat[],
  driveId: string | null,
): Map<string, [string, string | null]> {
  const folders = new Map<string, [string, string | null]>()
  for (const row of rows) {
    const key = rel !== '' ? `${rel}/${row.name}` : row.name
    found.set(key, row)
    folders.delete(key)
    if (row.type === FileType.DIRECTORY) {
      const own = row.extra.drive_id
      folders.set(key, [
        row.extra.file_id as string,
        typeof own === 'string' && own !== '' ? own : driveId,
      ])
    }
  }
  return folders
}
