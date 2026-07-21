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
import { mkdir as opfsMkdir } from '../../../core/opfs/mkdir.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

async function mkdirCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const parents = opts.flags.p === true
  const verbose = opts.flags.v === true
  if (paths.length === 0) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode('mkdir: missing operand\n'),
      }),
    ]
  }
  const lines: string[] = []
  for (const p of paths) {
    await opfsMkdir(accessor, p, parents)
    if (verbose) lines.push(`mkdir: created directory '${p.virtual.replace(/\/+$/, '') || '/'}'`)
  }
  const output: ByteSource | null = verbose && lines.length > 0 ? formatRecords(lines) : null
  return [output, new IOResult()]
}

export const OPFS_MKDIR = command({
  name: 'mkdir',
  resource: ResourceName.OPFS,
  spec: specOf('mkdir'),
  fn: mkdirCommand,
  write: true,
})
