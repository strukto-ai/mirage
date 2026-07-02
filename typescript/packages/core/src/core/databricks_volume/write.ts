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

import { invalidateAfterWrite } from '../../cache/context.ts'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { record } from '../../observe/context.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import { dbxFetch } from './_client.ts'
import { ensurePathSpec, parentPath } from './_helpers.ts'
import { isNotFound, notADirectoryError, notFoundError } from './errors.ts'
import { backendPath } from './path.ts'

async function ensureParentDirectory(
  accessor: DatabricksVolumeAccessor,
  remoteParent: string,
  virtualTarget: string,
): Promise<void> {
  try {
    await dbxFetch(accessor, 'HEAD', 'directories', remoteParent)
    return
  } catch (exc) {
    if (!isNotFound(exc)) throw exc
  }
  try {
    await dbxFetch(accessor, 'HEAD', 'files', remoteParent)
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(virtualTarget)
    throw exc
  }
  throw notADirectoryError(virtualTarget)
}

export async function writeBytes(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  data: Uint8Array,
  _index?: IndexCacheStore,
): Promise<void> {
  const p = ensurePathSpec(path)
  const remoteParent = backendPath(accessor.config, parentPath(p))
  const remotePath = backendPath(accessor.config, p)
  const startMs = performance.now()
  await ensureParentDirectory(accessor, remoteParent, p.virtual)
  try {
    await dbxFetch(accessor, 'PUT', 'files', remotePath, {
      query: { overwrite: 'true' },
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    })
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(p.virtual)
    throw exc
  }
  record('write', p.virtual, ResourceName.DATABRICKS_VOLUME, data.byteLength, startMs)
  await invalidateAfterWrite(p)
}
