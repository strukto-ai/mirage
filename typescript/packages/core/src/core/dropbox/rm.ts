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
import { invalidateAfterUnlink } from '../../cache/context.ts'
import { record } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { DropboxApiError } from './_client.ts'
import { deletePath } from './api.ts'
import { invalidateAncestors } from '../../cache/context.ts'
import { dropboxPathOf } from './paths.ts'

// delete_v2 removes folders recursively, so rm -r maps to one call.
export async function rmR(accessor: DropboxAccessor, path: PathSpec): Promise<void> {
  const apiPath = dropboxPathOf(accessor, path)
  const startMs = performance.now()
  try {
    await deletePath(accessor.tokenManager, apiPath)
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) throw enoent(path.virtual)
    throw err
  }
  record('rm_r', path.virtual, 'dropbox', 0, startMs)
  await invalidateAfterUnlink(path)
  await invalidateAncestors(path)
}
