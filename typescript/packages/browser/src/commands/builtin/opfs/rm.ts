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
  specOf,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { rmdir as opfsRmdir } from '../../../core/opfs/rmdir.ts'
import { stat as opfsStat } from '../../../core/opfs/stat.ts'
import { unlink as opfsUnlink } from '../../../core/opfs/unlink.ts'
import { rmR as opfsRmR } from '../../../core/opfs/rm.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

async function rmCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode('rm: missing operand\n'),
      }),
    ]
  }
  const recursive = opts.flags.r === true || opts.flags.R === true
  const dirFlag = opts.flags.d === true
  const force = opts.flags.f === true
  const errors: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const p of paths) {
    let isDir = false
    try {
      const st = await opfsStat(accessor, p)
      isDir = st.type === FileType.DIRECTORY
    } catch {
      if (force) continue
      // GNU rm reports the operand and keeps removing the rest.
      errors.push(`rm: cannot remove '${p.virtual}': No such file or directory`)
      continue
    }
    if (isDir) {
      if (recursive) {
        await opfsRmR(accessor, p)
      } else if (dirFlag) {
        await opfsRmdir(accessor, p)
      } else {
        errors.push(`rm: cannot remove '${p.virtual}': Is a directory`)
        continue
      }
    } else {
      await opfsUnlink(accessor, p)
    }
    writes[p.mountPath] = new Uint8Array()
  }
  const stderr = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : undefined
  return [
    null,
    new IOResult({
      writes,
      exitCode: errors.length > 0 ? 1 : 0,
      ...(stderr !== undefined ? { stderr } : {}),
    }),
  ]
}

export const OPFS_RM = command({
  name: 'rm',
  resource: ResourceName.OPFS,
  spec: specOf('rm'),
  fn: rmCommand,
  write: true,
})
