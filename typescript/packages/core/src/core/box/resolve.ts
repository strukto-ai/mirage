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
import type { PathSpec } from '../../types.ts'
import { listFolderItems, type BoxItem } from './api.ts'
import { vfsNameFor } from './readdir.ts'

export function pathParts(path: PathSpec): string[] {
  return path.resourcePath.split('/').filter((p) => p !== '')
}

// Box has no path-addressing endpoint, so writes resolve ids by listing each
// level from the mount root. Returns the Box item for the full path, or null
// if any component is missing (or a non-final component is not a folder).
// Matches vfs names so paths spelled with the `.json` suffix on box-native
// files still resolve.
export async function resolveItem(accessor: BoxAccessor, parts: string[]): Promise<BoxItem | null> {
  const tm = accessor.tokenManager
  let curId = accessor.rootFolderId
  let cur: BoxItem | null = null
  for (let i = 0; i < parts.length; i++) {
    const children = await listFolderItems(tm, curId)
    const match = children.find((c) => vfsNameFor(c.name) === parts[i])
    if (match === undefined) return null
    cur = match
    if (i < parts.length - 1) {
      if (match.type !== 'folder') return null
      curId = match.id
    }
  }
  return cur
}

export async function resolveParentId(
  accessor: BoxAccessor,
  parts: string[],
): Promise<string | null> {
  if (parts.length <= 1) return accessor.rootFolderId
  const parent = await resolveItem(accessor, parts.slice(0, -1))
  if (parent?.type !== 'folder') return null
  return parent.id
}
