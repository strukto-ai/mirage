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
import { record, startOp } from '../../observe/context.ts'
import { VFSName, type PathSpec } from '../../types.ts'
import { ByteSpool } from '../../io/spool.ts'
import type { ByteSource } from '../../io/types.ts'
import { getDirectoryMetadata, getMetadata, MAX_UPLOAD_SIZE, upload } from './client.ts'
import { ensurePathSpec, parentPath } from './_helpers.ts'
import { isNotFound } from './errors.ts'
import { backendPath } from './path.ts'
import { efbig, enoent, enotdir } from '../../errors/fs.ts'

async function ensureParentDirectory(
  accessor: DatabricksVolumeAccessor,
  remoteParent: string,
  virtualTarget: string,
): Promise<void> {
  try {
    await getDirectoryMetadata(accessor, remoteParent)
    return
  } catch (exc) {
    if (!isNotFound(exc)) throw exc
  }
  try {
    await getMetadata(accessor, remoteParent)
  } catch (exc) {
    if (isNotFound(exc)) throw enoent(virtualTarget)
    throw exc
  }
  throw enotdir(virtualTarget)
}

/**
 * Write a file in one PUT streamed from a spool, which knows its length; one
 * past the PUT's cap is refused before any request. Mirrors Python's `write`.
 */
export async function write(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  data: ByteSource,
): Promise<void> {
  const p = ensurePathSpec(path)
  const remoteParent = backendPath(accessor.config, parentPath(p))
  const remotePath = backendPath(accessor.config, p)
  const spool = new ByteSpool()
  try {
    await spool.fill(data)
    if (spool.size > MAX_UPLOAD_SIZE) throw efbig(p.virtual)
    const timer = startOp()
    await ensureParentDirectory(accessor, remoteParent, p.virtual)
    try {
      await upload(accessor, remotePath, spool, true)
    } catch (exc) {
      if (isNotFound(exc)) throw enoent(p.virtual)
      throw exc
    }
    record('write', p.virtual, VFSName.DATABRICKS_VOLUME, spool.size, timer)
  } finally {
    await spool.close()
  }
}
