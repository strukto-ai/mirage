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

import type { BoxAccessor } from '../../accessor/box.ts'
import { enoent, enotdir } from '../../errors/fs.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import {
  getFileInfo,
  listFolderItems,
  type BoxFileInfo,
  type BoxItem,
  type BoxSearchItem,
} from './api.ts'
import { BoxApiError } from './client.ts'
import { ACTIVE, ALL_FILES_FOLDER_ID, SHA1, TRASH_FOLDER_ID } from './constants.ts'

export function pathParts(path: PathSpec): string[] {
  return path.vfsPath.split('/').filter((p) => p !== '')
}

/**
 * Walk folder listings to resolve each component of a path.
 *
 * Box has no path-addressing endpoint, so ids are resolved by listing each
 * level from the mount root. Returns the Box item for every component that
 * resolved, in order; a missing component, or one below a non-folder, ends
 * the chain early.
 */
export async function resolveChain(accessor: BoxAccessor, parts: string[]): Promise<BoxItem[]> {
  const tm = accessor.tokenManager
  let curId = accessor.rootFolderId
  const chain: BoxItem[] = []
  for (const name of parts) {
    if (chain.length > 0 && chain[chain.length - 1]?.type !== 'folder') break
    const children = await listFolderItems(tm, curId)
    const match = children.find((c) => c.name === name)
    if (match === undefined) break
    chain.push(match)
    curId = match.id
  }
  return chain
}

/**
 * Resolve a mount-relative path to its Box item.
 *
 * Returns null if any component is missing, or a non-final component is not
 * a folder.
 */
export async function resolveItem(accessor: BoxAccessor, parts: string[]): Promise<BoxItem | null> {
  const chain = await resolveChain(accessor, parts)
  if (parts.length === 0 || chain.length < parts.length) return null
  return chain[chain.length - 1] ?? null
}

/**
 * The Box item a listed row names, in the shape a lookup answers. Mirrors
 * Python's `item_of`.
 */
export function itemOf(row: FileStat | null | undefined): BoxItem | null {
  if (row === null || row === undefined) return null
  const sha1 = row.extra[SHA1]
  const etag = row.extra.etag
  return {
    id: row.extra.box_id as string,
    type: row.type === FileType.DIRECTORY ? 'folder' : 'file',
    name: row.name,
    ...(typeof sha1 === 'string' ? { sha1 } : {}),
    ...(typeof etag === 'string' ? { etag } : {}),
  }
}

/**
 * The folder a create at `path` lands in: the mount root's, or what is at the
 * parent path. A missing or non-directory parent names the operand, as
 * mkdir(2) does. Mirrors Python's `parent_folder`.
 */
export function parentFolder(
  accessor: BoxAccessor,
  path: PathSpec,
  parent: FileStat | null | undefined,
): string {
  if (pathParts(path).length <= 1) return accessor.rootFolderId
  if (parent === null || parent === undefined) throw enoent(path.virtual)
  if (parent.type !== FileType.DIRECTORY) throw enotdir(path.virtual)
  return parent.extra.box_id as string
}

/**
 * Mount-relative path of an item, from its `path_collection`.
 *
 * Box lists an item's ancestors from the account root down to its immediate
 * parent, excluding the item itself; everything up to and including the mount
 * root folder is trimmed. Null when the mount root is not among the
 * ancestors, which is every item outside the mount.
 */
export function mountRelativeKey(
  item: Pick<BoxSearchItem, 'name' | 'path_collection'>,
  rootFolderId: string,
): string | null {
  const entries = item.path_collection?.entries ?? []
  const names: string[] = []
  let collecting = false
  for (const anc of entries) {
    if (collecting) names.push(anc.name)
    if (anc.id === rootFolderId) collecting = true
  }
  if (!collecting) return null
  names.push(item.name)
  return names.filter((n) => n !== '').join('/')
}

/**
 * Whether a live `GET /files/{id}` answer is the active file at `path`.
 *
 * Box enforces unique names per folder, so a file whose live chain of names
 * from the mount root equals the path is the very item walking the path would
 * reach. Four checks: the item is a file, its `item_status` is active, its
 * `path_collection` starts at All Files and passes no Trash folder, and its
 * names below the mount root equal the path. The name comparison alone
 * already rejects a trashed chain below the mount root; the All Files check
 * also refuses a chain that does not start at All Files yet passes through
 * the mount root with the right names below it, which the name comparison
 * alone would accept, and with the Trash check catches the mount root itself
 * in Trash.
 */
export function namesThisPath(accessor: BoxAccessor, item: BoxFileInfo, path: PathSpec): boolean {
  if (item.type !== 'file' || item.item_status !== ACTIVE) return false
  const chain = item.path_collection?.entries ?? []
  if (chain.length === 0 || chain[0]?.id !== ALL_FILES_FOLDER_ID) return false
  if (chain.some((anc) => anc.id === TRASH_FOLDER_ID)) return false
  return mountRelativeKey(item, accessor.rootFolderId) === pathParts(path).join('/')
}

/**
 * What is at `path` now, asked live. A listed row can be older than the
 * version an op holds, so a check or a conditional write asks again: one
 * `GET /files/{id}` by the id the row names, when the answer is still the
 * active file at exactly this path, else a walk of the listings from the
 * mount root. Only the walk may call a path gone, so a 404 or 403 by id falls
 * back to it rather than answering null. Mirrors Python's `live_item`.
 */
export async function liveItem(
  accessor: BoxAccessor,
  path: PathSpec,
  lead: BoxItem | null,
): Promise<BoxItem | null> {
  if (lead?.type === 'file' && lead.id !== '') {
    let item: BoxFileInfo | null = null
    try {
      item = await getFileInfo(accessor.tokenManager, lead.id)
    } catch (err) {
      if (!(err instanceof BoxApiError) || (err.status !== 403 && err.status !== 404)) throw err
      console.warn(`listed id for ${path.virtual} unusable: ${String(err)}`)
    }
    if (item !== null && namesThisPath(accessor, item, path)) return item
  }
  return resolveItem(accessor, pathParts(path))
}
