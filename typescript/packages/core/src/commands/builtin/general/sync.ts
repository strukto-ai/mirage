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
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { quoteText } from '../../quote.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENC = new TextEncoder()
const BOTH = ENC.encode('sync: cannot specify both --data and --file-system\n')
const NO_DATA = ENC.encode('sync: --data needs at least one argument\n')

// Every write has landed by the time its command ends, so only the operands
// are checked.
async function sync(
  _accessor: Accessor,
  paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('sync'))
  if (fl.asBool('data') && fl.asBool('file_system'))
    return [null, new IOResult({ exitCode: 1, stderr: BOTH })]
  if (fl.asBool('data') && paths.length === 0)
    return [null, new IOResult({ exitCode: 1, stderr: NO_DATA })]
  const err: string[] = []
  if (ctx.vfs !== undefined) {
    for (const path of paths) {
      try {
        await ctx.vfs.stat(path)
      } catch (error) {
        if (!isFsError(error)) throw error
        err.push(`sync: error opening '${quoteText(path.rawPath)}': ${String(fsStrerror(error))}\n`)
      }
    }
  }
  if (err.length > 0) return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(err.join('')) })]
  return [null, new IOResult()]
}

export const GENERAL_SYNC = command({ name: 'sync', vfs: null, spec: specOf('sync'), fn: sync })
