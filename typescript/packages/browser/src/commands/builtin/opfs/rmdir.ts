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
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { readdir as opfsReaddir } from '../../../core/opfs/readdir.ts'
import { rmdir as opfsRmdir } from '../../../core/opfs/rmdir.ts'
import { stat as opfsStat } from '../../../core/opfs/stat.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

async function rmdirCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const enc = new TextEncoder()
  if (paths.length === 0) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: enc.encode("rmdir: missing operand\nTry 'rmdir --help' for more information.\n"),
      }),
    ]
  }
  const verbose = opts.flags.v === true
  const errors: string[] = []
  const verboseParts: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const p of paths) {
    let isDir = false
    try {
      isDir = (await opfsStat(accessor, p)).type === FileType.DIRECTORY
    } catch {
      errors.push(`rmdir: failed to remove '${p.virtual}': No such file or directory`)
      continue
    }
    if (!isDir) {
      errors.push(`rmdir: failed to remove '${p.virtual}': Not a directory`)
      continue
    }
    if ((await opfsReaddir(accessor, p)).length > 0) {
      errors.push(`rmdir: failed to remove '${p.virtual}': Directory not empty`)
      continue
    }
    await opfsRmdir(accessor, p)
    writes[p.mountPath] = new Uint8Array()
    if (verbose) verboseParts.push(`rmdir: removing directory, '${p.virtual}'`)
  }
  const output: ByteSource | null =
    verbose && verboseParts.length > 0 ? formatRecords(verboseParts) : null
  const stderr = errors.length > 0 ? enc.encode(errors.join('\n') + '\n') : undefined
  return [
    output,
    new IOResult({
      writes,
      exitCode: errors.length > 0 ? 1 : 0,
      ...(stderr !== undefined ? { stderr } : {}),
    }),
  ]
}

export const OPFS_RMDIR = command({
  name: 'rmdir',
  resource: ResourceName.OPFS,
  spec: specOf('rmdir'),
  fn: rmdirCommand,
  write: true,
})
