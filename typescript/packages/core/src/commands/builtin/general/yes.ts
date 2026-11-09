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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { encodeText } from '../../../shell/bytes.ts'

const BLOCK_SIZE = 64 * 1024

async function* repeated(block: Uint8Array, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const budget = new YieldBudget(signal)
  for (;;) {
    yield block
    await budget.run()
  }
}

// Print the operands, or y, until the reader stops reading.
function yes(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const line =
    texts.length > 0 ? encodeText(texts.join(' ') + '\n') : new TextEncoder().encode('y\n')
  const copies = Math.floor(BLOCK_SIZE / line.byteLength) + 1
  const block = new Uint8Array(copies * line.byteLength)
  for (let i = 0; i < copies; i++) block.set(line, i * line.byteLength)
  return [repeated(block, ctx.signal), new IOResult()]
}

export const GENERAL_YES = command({ name: 'yes', vfs: null, spec: specOf('yes'), fn: yes })
