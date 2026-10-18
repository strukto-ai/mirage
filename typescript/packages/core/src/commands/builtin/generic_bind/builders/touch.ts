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

import { IOResult } from '../../../../io/types.ts'
import { fsStrerror, isFsError } from '../../../../errors/fs.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles } from '../files.ts'
import { UsageError } from '../../../errors.ts'
import { usageHint } from '../../../spec/usage.ts'

const ENC = new TextEncoder()

const touch: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  if (paths.length === 0) {
    throw new UsageError(`touch: missing file operand\n${usageHint('touch')}`, 1)
  }
  const resolved = await files.resolveGlob(paths)
  const createOnly = new FlagView(ctx.flags, specOf('touch')).asBool('no_create')
  const errors: string[] = []
  for (const p of resolved) {
    if (createOnly) continue
    if (await files.exists(p)) continue
    try {
      await files.write(p, new Uint8Array(0))
    } catch (err) {
      // One unusable operand is not an aborted command: GNU reports it
      // and still touches the remaining ones.
      if (!isFsError(err)) throw err
      errors.push(`touch: cannot touch '${p.virtual}': ${String(fsStrerror(err))}`)
    }
  }
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [null, new IOResult({ stderr, exitCode: errors.length > 0 ? 1 : 0 })]
}

export const BUILDER: GenericCommand = {
  name: 'touch',
  write: true,
  fn: touch,
}
