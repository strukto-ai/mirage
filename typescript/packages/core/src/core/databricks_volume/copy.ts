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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { dbxFetch } from './_client.ts'
import { ensurePathSpec } from './_helpers.ts'
import { isADirectoryError } from './errors.ts'
import { backendPath } from './path.ts'
import { readBytes } from './read.ts'
import { listDirectoryContents } from './readdir.ts'
import { stat } from './stat.ts'
import { writeBytes } from './write.ts'

async function uploadBytes(
  accessor: DatabricksVolumeAccessor,
  remotePath: string,
  data: Uint8Array,
): Promise<void> {
  await dbxFetch(accessor, 'PUT', 'files', remotePath, {
    query: { overwrite: 'true' },
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
  })
}

async function downloadBytes(
  accessor: DatabricksVolumeAccessor,
  remotePath: string,
): Promise<Uint8Array> {
  const r = await dbxFetch(accessor, 'GET', 'files', remotePath, {
    headers: { Accept: 'application/octet-stream' },
  })
  return new Uint8Array(await r.arrayBuffer())
}

async function copyTree(
  accessor: DatabricksVolumeAccessor,
  remoteSrc: string,
  remoteDst: string,
): Promise<void> {
  await dbxFetch(accessor, 'PUT', 'directories', remoteDst)
  for (const entry of await listDirectoryContents(accessor, remoteSrc)) {
    const name = rstripSlash(entry.path).split('/').pop() ?? ''
    const childDst = `${rstripSlash(remoteDst)}/${name}`
    if (entry.is_directory === true) {
      await copyTree(accessor, entry.path, childDst)
    } else {
      await uploadBytes(accessor, childDst, await downloadBytes(accessor, entry.path))
    }
  }
}

export async function copy(
  accessor: DatabricksVolumeAccessor,
  src: PathSpec,
  dst: PathSpec,
  index?: IndexCacheStore,
  recursive = false,
): Promise<void> {
  const s = ensurePathSpec(src)
  const d = ensurePathSpec(dst)
  const srcStat = await stat(accessor, s, index)
  // Same-path guard runs after stat (and the non-recursive directory check)
  // so a missing source or `cp` of a directory still raises.
  const samePath = backendPath(accessor.config, s) === backendPath(accessor.config, d)
  if (srcStat.type === FileType.DIRECTORY) {
    if (!recursive) throw isADirectoryError(s.virtual)
    if (samePath) return
    const remoteSrc = backendPath(accessor.config, s)
    const remoteDst = backendPath(accessor.config, d)
    if (remoteDst.startsWith(remoteSrc + '/')) {
      // Copying a directory into its own subtree creates the destination
      // inside the source, so the walk would descend into the fresh copy
      // forever. Refuse before any create_directory/upload.
      throw new Error(`cannot copy a directory, '${s.virtual}', into itself, '${d.virtual}'`)
    }
    await copyTree(accessor, remoteSrc, remoteDst)
    return
  }
  if (samePath) {
    // Copying a file onto itself would re-upload it; skip.
    return
  }
  const data = await readBytes(accessor, s, index)
  await writeBytes(accessor, d, data, index)
}
