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

import type { DatabricksVolumeAccessor } from '../../../accessor/databricks_volume.ts'
import { resolveGlob } from '../../../core/databricks_volume/glob.ts'
import { readdir as dbxReaddir } from '../../../core/databricks_volume/readdir.ts'
import { rmRecursive as dbxRmR } from '../../../core/databricks_volume/rm.ts'
import { rmdir as dbxRmdir } from '../../../core/databricks_volume/rmdir.ts'
import { stat as dbxStat } from '../../../core/databricks_volume/stat.ts'
import { unlink as dbxUnlink } from '../../../core/databricks_volume/unlink.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

interface RmOpts {
  recursive: boolean
  force: boolean
  removeDir: boolean
}

async function rmOne(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  opts: RmOpts,
  index: CommandOpts['index'],
): Promise<void> {
  let isDir = false
  try {
    const st = await dbxStat(accessor, path, index ?? undefined)
    isDir = st.type === FileType.DIRECTORY
  } catch (err) {
    if (opts.force) return
    throw err
  }
  if (isDir) {
    if (opts.recursive) {
      await dbxRmR(accessor, path)
    } else if (opts.removeDir) {
      const children = await dbxReaddir(accessor, path, index ?? undefined)
      if (children.length > 0) {
        throw new Error(`directory not empty: ${path.virtual}`)
      }
      await dbxRmdir(accessor, path)
    } else {
      throw new Error(`${path.virtual}: is a directory (use recursive=True)`)
    }
  } else {
    await dbxUnlink(accessor, path)
  }
}

async function rmCommand(
  accessor: DatabricksVolumeAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('rm: missing operand\n') })]
  }
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const recursive = opts.flags.r === true || opts.flags.R === true
  const force = opts.flags.f === true
  const removeDir = opts.flags.d === true
  const verbose = opts.flags.v === true
  const verboseParts: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const p of resolved) {
    try {
      await rmOne(accessor, p, { recursive, force, removeDir }, opts.index)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
    writes[p.mountPath] = new Uint8Array()
    if (verbose) verboseParts.push(`removed '${p.virtual}'`)
  }
  const output: ByteSource | null = verbose ? formatRecords(verboseParts) : null
  return [output, new IOResult({ writes })]
}

export const DATABRICKS_VOLUME_RM = command({
  name: 'rm',
  resource: ResourceName.DATABRICKS_VOLUME,
  spec: specOf('rm'),
  fn: rmCommand,
  write: true,
})
