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

import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { FileType, type PathSpec } from '../../types.ts'

import { deleteFile, deleteDirectory, listDirectoryContents } from './client.ts'
import { ensurePathSpec } from './_helpers.ts'
import { isNotFound } from './errors.ts'
import { backendPath, virtualPath } from './path.ts'
import { stat } from './stat.ts'
import type { DirectoryEntry } from './types.ts'
import { unlink } from './unlink.ts'
import { enoent, enotempty } from '../../errors/fs.ts'

/** Whether a directory lists any entry; a missing one holds none. Mirrors Python's `holds_child`. */
export async function holdsChild(
  accessor: DatabricksVolumeAccessor,
  remoteDir: string,
): Promise<boolean> {
  try {
    return (await listDirectoryContents(accessor, remoteDir)).length > 0
  } catch (exc) {
    if (isNotFound(exc)) return false
    throw exc
  }
}

// Whether a move copied this entry as it is listed now. Mirrors Python's
// `_as_copied`.
function asCopied(copied: Map<string, DirectoryEntry>, entry: DirectoryEntry): boolean {
  const seen = copied.get(entry.path)
  return (
    seen?.isDirectory === entry.isDirectory &&
    seen.fileSize === entry.fileSize &&
    seen.lastModified === entry.lastModified
  )
}

async function removeTreeRecurse(
  accessor: DatabricksVolumeAccessor,
  remoteDir: string,
  removed: string[],
  copied: Map<string, DirectoryEntry> | null,
): Promise<boolean> {
  let left = false
  for (const entry of await listDirectoryContents(accessor, remoteDir)) {
    if (copied !== null && !asCopied(copied, entry)) {
      left = true
    } else if (entry.isDirectory) {
      left = (await removeTreeRecurse(accessor, entry.path, removed, copied)) || left
    } else {
      await deleteFile(accessor, entry.path)
      removed.push(entry.path)
    }
  }
  if (left) return true
  try {
    await deleteDirectory(accessor, remoteDir)
  } catch (exc) {
    // The Files API deletes only an empty directory, so a file written
    // after the listing refuses it.
    if (isNotFound(exc) || !(await holdsChild(accessor, remoteDir))) throw exc
    return true
  }
  removed.push(remoteDir)
  return false
}

/**
 * Remove a directory tree, or only what a move copied out of it (`copied`,
 * the entries by backend path as their listing showed them; only an entry
 * still listed the same is deleted, and null deletes every entry listed).
 * The walk lists each directory once, so a file written under it since, or
 * an entry the move never copied or that changed since its copy, stays and
 * keeps its directories: the tree is ENOTEMPTY. Returns the backend paths removed. Mirrors Python's
 * `remove_tree`.
 */
export async function removeTree(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  copied: Map<string, DirectoryEntry> | null = null,
): Promise<string[]> {
  const removed: string[] = []
  let left: boolean
  try {
    left = await removeTreeRecurse(accessor, backendPath(accessor.config, path), removed, copied)
  } catch (exc) {
    if (isNotFound(exc)) throw enoent(path.virtual)
    throw exc
  }
  if (left) throw enotempty(path.virtual)
  return removed
}

export async function rmRecursive(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
): Promise<string[]> {
  const p = ensurePathSpec(path)
  const fileStat = await stat(accessor, p)
  if (fileStat.type !== FileType.DIRECTORY) {
    await unlink(accessor, p)
    return [p.mountPath]
  }
  const removed = await removeTree(accessor, p)
  return removed.map((backend) => virtualPath(accessor.config, backend, ''))
}
