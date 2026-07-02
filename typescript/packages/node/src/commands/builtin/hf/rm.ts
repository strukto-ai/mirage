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
  command,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { HF_RESOURCES, type HfAccessor } from '../../../accessor/hf.ts'
import { resolveGlob } from '../../../core/hf/glob.ts'
import { stat as hfStat } from '../../../core/hf/stat.ts'
import { unlink as hfUnlink } from '../../../core/hf/unlink.ts'

const ENC = new TextEncoder()

// eslint-disable-next-line @typescript-eslint/require-await
async function* lines(parts: readonly string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield ENC.encode(`${part}\n`)
}

async function rmCommand(
  accessor: HfAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('rm: missing operand\n') })]
  }
  const recursive = opts.flags.r === true || opts.flags.R === true
  const dirFlag = opts.flags.d === true
  const force = opts.flags.f === true
  const verbose = opts.flags.v === true
  const idx = opts.index ?? undefined
  const resolved = await resolveGlob(accessor, paths, idx)
  const verboseParts: string[] = []
  const removed: Record<string, Uint8Array> = {}
  for (const path of resolved) {
    let s
    try {
      s = await hfStat(accessor, path, idx)
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code === 'ENOENT' && force) continue
      if (code === 'ENOENT') {
        throw new Error(`rm: cannot remove '${path.virtual}': No such file or directory`)
      }
      throw err
    }
    // HF repos have no server-side directory removal; a plain file still
    // unlinks even with -r, matching GNU and the Python generic rm.
    if (s.type === FileType.DIRECTORY) {
      if (recursive) throw new Error('rm: recursive remove not supported on this backend')
      if (dirFlag) throw new Error('rm: directory remove not supported on this backend')
      throw new Error(`rm: cannot remove '${path.virtual}': Is a directory`)
    }
    await hfUnlink(accessor, path, idx)
    removed[path.mountPath] = new Uint8Array()
    if (verbose) verboseParts.push(`removed '${path.virtual}'`)
  }
  const output: ByteSource | null = verbose ? lines(verboseParts) : null
  return [output, new IOResult({ writes: removed })]
}

export const HF_RM = command({
  name: 'rm',
  resource: [...HF_RESOURCES],
  spec: specOf('rm'),
  fn: rmCommand,
  write: true,
})
