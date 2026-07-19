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
import type { PathSpec } from '../../types.ts'
import { DropboxApiError } from './_client.ts'
import { getMetadata } from './api.ts'
import { dropboxPathOf } from './paths.ts'

export async function exists(accessor: DropboxAccessor, path: PathSpec): Promise<boolean> {
  const apiPath = dropboxPathOf(accessor, path)
  if (apiPath === accessor.rootPath) return true
  try {
    await getMetadata(accessor.tokenManager, apiPath)
    return true
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) return false
    throw err
  }
}
