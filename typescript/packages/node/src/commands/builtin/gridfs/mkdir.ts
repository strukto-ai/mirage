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
  FlagView,
  IOResult,
  ResourceName,
  command,
  resolveGlobOf,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { mkdir as gridfsMkdir } from '../../../core/gridfs/mkdir.ts'
import { GRIDFS_IO } from './io.ts'
import { mkdirLinkRefusal } from '@struktoai/mirage-core'

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
  const fl = new FlagView(opts.flags, specOf('mkdir'))
  const verbose = fl.asBool('verbose')
  const parents = fl.asBool('parents')
  const lines: string[] = []
  const writes: Record<string, Uint8Array> = {}
  const errors: string[] = []
  const links = opts.ns?.links ?? null
  for (const path of resolved) {
    // A symlink occupying the name is EEXIST; the shared helper keeps
    // this identical to the generic builder's answer.
    const collision = await mkdirLinkRefusal(path, links, { parents })
    if (collision.taken) {
      if (collision.message !== null) errors.push(collision.message)
      continue
    }
    await gridfsMkdir(accessor, path, parents)
    writes[path.mountPath] = new Uint8Array()
    if (verbose) lines.push(`mkdir: created directory '${path.virtual}'`)
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : undefined
  return [
    output,
    new IOResult({
      writes,
      exitCode: errors.length > 0 ? 1 : 0,
      ...(stderr !== undefined ? { stderr } : {}),
    }),
  ]
}

export const GRIDFS_MKDIR = command({
  name: 'mkdir',
  resource: ResourceName.GRIDFS,
  spec: specOf('mkdir'),
  fn: mkdirCommand,
  write: true,
})
