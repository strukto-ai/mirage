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

import type { GSlidesAccessor } from '../../../accessor/gslides.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GSLIDES_CMD_OPS } from './ops.ts'
import { unlink } from '../../../core/gslides/unlink.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { formatRecords } from '../utils/output.ts'

const resolveGlob = resolveGlobOf(GSLIDES_CMD_OPS)

const ENC = new TextEncoder()

async function rmCommand(
  accessor: GSlidesAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('rm: missing operand\n') })]
  }
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const force = opts.flags.f === true
  const verbose = opts.flags.v === true
  const verboseParts: string[] = []
  const writes: Record<string, Uint8Array> = {}
  for (const p of resolved) {
    try {
      await unlink(accessor, p, opts.index ?? undefined)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (force && code === 'ENOENT') continue
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
    }
    writes[p.mountPath] = new Uint8Array()
    if (verbose) verboseParts.push(`removed '${p.virtual}'`)
  }
  const output: ByteSource | null = verbose ? formatRecords(verboseParts) : null
  return [output, new IOResult({ writes })]
}

export const GSLIDES_RM = command({
  name: 'rm',
  resource: ResourceName.GSLIDES,
  spec: specOf('rm'),
  fn: rmCommand,
  write: true,
})
