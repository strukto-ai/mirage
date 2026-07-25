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
import { invalidateAfterUnlink, invalidateAfterWrite } from '../../cache/context.ts'
import { record } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { DropboxApiError } from './_client.ts'
import { deletePath, getMetadata, movePath } from './api.ts'
import { invalidateAncestors } from '../../cache/context.ts'
import { dropboxPathOf } from './paths.ts'

// move_v2 rejects an existing destination; GNU mv silently replaces a
// destination FILE, so a file conflict deletes the target and retries.
// Folder conflicts propagate (the generic mv resolves into-dir moves
// before calling this).
export async function rename(
  accessor: DropboxAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const from = dropboxPathOf(accessor, src)
  const to = dropboxPathOf(accessor, dst)
  const startMs = performance.now()
  try {
    await movePath(accessor.tokenManager, from, to)
  } catch (err) {
    if (!(err instanceof DropboxApiError)) throw err
    if (err.summary.startsWith('from_lookup/not_found')) throw enoent(src.virtual)
    if (!err.summary.startsWith('to/conflict')) throw err
    const existing = await getMetadata(accessor.tokenManager, to)
    if (existing['.tag'] === 'folder') throw err
    await deletePath(accessor.tokenManager, to)
    await movePath(accessor.tokenManager, from, to)
  }
  record('rename', src.virtual, 'dropbox', 0, startMs)
  await invalidateAfterUnlink(src)
  await invalidateAncestors(src)
  await invalidateAfterWrite(dst)
  await invalidateAncestors(dst)
}
