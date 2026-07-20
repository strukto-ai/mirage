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

import {
  FileType,
  IOResult,
  ResourceName,
  command,
  formatRecords,
  resolveGlobOf,
  specOf,
  writeMetadataProvision,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { readdir as gridfsReaddir } from '../../../core/gridfs/readdir.ts'
import { rmR as gridfsRmR } from '../../../core/gridfs/rm.ts'
import { rmdir as gridfsRmdir } from '../../../core/gridfs/rmdir.ts'
import { stat as gridfsStat } from '../../../core/gridfs/stat.ts'
import { unlink as gridfsUnlink } from '../../../core/gridfs/unlink.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

const ENC = new TextEncoder()

interface RmOpts {
  recursive: boolean
  force: boolean
  removeDir: boolean
}

async function rmOne(
  accessor: GridFSAccessor,
  path: PathSpec,
  opts: RmOpts,
  index: CommandOpts['index'],
): Promise<void> {
  let isDir = false
  try {
    const st = await gridfsStat(accessor, path, index ?? undefined)
    isDir = st.type === FileType.DIRECTORY
  } catch (err) {
    if (opts.force) return
    throw err
  }
  if (isDir) {
    if (opts.recursive) {
      await gridfsRmR(accessor, path)
    } else if (opts.removeDir) {
      const children = await gridfsReaddir(accessor, path, index ?? undefined)
      if (children.length > 0) {
        throw new Error(`directory not empty: ${path.virtual}`)
      }
      await gridfsRmdir(accessor, path)
    } else {
      throw new Error(`${path.virtual}: is a directory (use recursive=True)`)
    }
  } else {
    await gridfsUnlink(accessor, path)
  }
}

async function rmCommand(
  accessor: GridFSAccessor,
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

export const GRIDFS_RM = command({
  name: 'rm',
  resource: ResourceName.GRIDFS,
  spec: specOf('rm'),
  fn: rmCommand,
  write: true,
  provision: writeMetadataProvision,
})
