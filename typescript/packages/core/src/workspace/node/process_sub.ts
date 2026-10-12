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

import { materialize } from '../../io/types.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { encodeText } from '../../shell/bytes.ts'
import { getProcessSubBody, getProcessSubDirection } from '../../shell/helpers.ts'
import { ProcessSubDirection } from '../../shell/types.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import type { EvaluationContext } from '../evaluation.ts'
import type { MountRegistry } from '../mount/registry.ts'

/** A node-local refusal; carry earlier output until executeNode catches it. */
export class ProcessSubError extends ExitSignal {
  constructor() {
    super(2, encodeText('mirage: unsupported: process substitution >(...)\n'))
  }
}

/**
 * The hook that opens a node's input process substitutions. Each `<(...)`
 * runs as its word expands, in order with the word's other expansions and
 * through the evaluator a `$(...)` there uses, and reads back as a buffered
 * device file rather than a host pipe, held until the node ends; a nested
 * node opens its own, so each lasts as long as the command naming it. An
 * output `>(...)` is refused: the node naming it fails with status 2.
 * Mirrors Python's `_process_input`.
 */
export function processInput(
  context: EvaluationContext,
  registry: MountRegistry,
  held: (readonly [DevVFS, string, number])[],
): NonNullable<EvaluationContext['frame']['processSub']> {
  return async (node, executeLine) => {
    if (getProcessSubDirection(node) === ProcessSubDirection.OUTPUT) throw new ProcessSubError()
    const [dev] = registry.resolve('/dev/null')
    if (!(dev instanceof DevVFS)) throw new Error('missing device filesystem')
    const [path, allocation] = dev.allocateInput()
    held.push([dev, path, allocation])
    const inner = getProcessSubBody(node)
    if (inner !== '') {
      const io = await executeLine(inner)
      dev.setInput(path, allocation, await materialize(io.stdout))
      context.frame.diagnostics.push(await materialize(io.stderr))
    }
    return path
  }
}
