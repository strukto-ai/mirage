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
  resolveGlobOf,
  specOf,
  writeMetadataProvision,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { mkdir as gridfsMkdir } from '../../../core/gridfs/mkdir.ts'
import { GRIDFS_IO } from './io.ts'

const resolveGlob = resolveGlobOf(GRIDFS_IO)

const ENC = new TextEncoder()

async function mkdirCommand(
  accessor: GridFSAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('mkdir: missing operand\n') })]
  }
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const verbose = opts.flags.v === true
  const lines: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const path of resolved) {
    await gridfsMkdir(accessor, path)
    writes[path.mountPath] = new Uint8Array()
    if (verbose) lines.push(`mkdir: created directory '${path.virtual}'`)
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  return [output, new IOResult({ writes })]
}

export const GRIDFS_MKDIR = command({
  name: 'mkdir',
  resource: ResourceName.GRIDFS,
  spec: specOf('mkdir'),
  fn: mkdirCommand,
  write: true,
  provision: writeMetadataProvision,
})
