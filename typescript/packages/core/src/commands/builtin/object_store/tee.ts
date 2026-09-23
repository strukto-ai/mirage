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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import type { RegisteredCommand } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { teeGeneric } from '../generic/tee.ts'
import { requireOp } from '../generic_bind/adapter.ts'
import { resolveGlobOf, type CommandIO } from '../generic_bind/index.ts'

const ENC = new TextEncoder()

/** Build the write-tracking tee override for one keyed store. */
export function makeTee<A extends Accessor>(vfs: string, io: CommandIO<A>): RegisteredCommand[] {
  const readStream = io.readStream
  const writeBytes = requireOp(io.write, 'write')
  const resolveGlob = resolveGlobOf(io)

  async function teeCommand(
    accessor: A,
    paths: PathSpec[],
    texts: string[],
    opts: CommandOpts,
  ): Promise<CommandFnResult> {
    if (paths.length === 0) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tee: missing operand\n') })]
    }
    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    // Wiring only: every flag semantic, the write to each operand and the
    // append fallback live in the generic.
    return teeGeneric(
      resolved,
      texts,
      opts,
      (p) => readStream(accessor, p),
      (p, d) => writeBytes(accessor, p, d),
    )
  }

  return command<A>({
    name: 'tee',
    vfs,
    spec: specOf('tee'),
    fn: teeCommand,
    write: true,
  })
}
