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

import type { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { GraphError, graphDelete } from '../msgraph/client.ts'
import { itemUrl } from './client.ts'

export async function unlink(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  try {
    await graphDelete(accessor.config, itemUrl(accessor.config, path.vfsPath))
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) throw enoent(path)
    throw error
  }
  await invalidateAfterUnlink(path)
}
