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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'
import { record, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { eexist, enoent } from '../../utils/errors.ts'
import { DropboxApiError } from './client.ts'
import { createFolder, getMetadata } from './api.ts'
import { invalidateAncestors } from '../../cache/context.ts'
import { dropboxPathOf } from './paths.ts'

async function metadataTag(
  accessor: DropboxAccessor,
  apiPath: string,
): Promise<'file' | 'folder' | null> {
  try {
    const entry = await getMetadata(accessor.tokenManager, apiPath)
    return entry['.tag'] === 'folder' ? 'folder' : 'file'
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) return null
    throw err
  }
}

/**
 * Create a folder; the doors have refused a taken name already.
 *
 * create_folder_v2 auto-creates missing parents, so ENOENT on a missing
 * parent without -p lives here, and its path conflict answers a name taken
 * after the doors looked. Under -p an existing folder is skipped, since the
 * create would conflict on it.
 */
export async function mkdir(
  accessor: DropboxAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const apiPath = dropboxPathOf(accessor, path)
  // The mount root always exists (the API rejects the empty path).
  if (apiPath === accessor.rootPath) {
    if (parents) return
    throw eexist(path.virtual)
  }
  if (parents && (await metadataTag(accessor, apiPath)) === 'folder') return
  if (!parents) {
    const parent = apiPath.slice(0, apiPath.lastIndexOf('/'))
    if (parent !== accessor.rootPath && (await metadataTag(accessor, parent)) !== 'folder') {
      throw enoent(path.virtual)
    }
  }
  const timer = startOp()
  try {
    await createFolder(accessor.tokenManager, apiPath)
  } catch (err) {
    if (err instanceof DropboxApiError && err.summary.startsWith('path/conflict')) {
      throw eexist(path.virtual)
    }
    throw err
  }
  record('mkdir', path.virtual, 'dropbox', 0, timer)
  await invalidateAfterWrite(path)
  await invalidateAncestors(path)
}
