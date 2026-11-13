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
import { runStream } from '../../../rs/stream.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveSource } from '../utils/stream.ts'
import { byteView } from '../../../shell/bytes.ts'
import { FlagView } from '../../spec/flag_view.ts'

function envsubst(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const variables = new FlagView(ctx.flags, specOf('envsubst')).asBool('variables')
  const env = variables
    ? {}
    : Object.fromEntries(
        Object.entries(ctx.env ?? {}).map(([name, value]) => [
          byteView(name),
          byteView(value),
        ]),
      )
  return [
    runStream(
      'envsubst',
      { args: texts.map(byteView), variables, env },
      variables ? new Uint8Array() : resolveSource(ctx.stdin),
    ),
    new IOResult(),
  ]
}

export const GENERAL_ENVSUBST = command({
  name: 'envsubst',
  vfs: null,
  spec: specOf('envsubst'),
  fn: envsubst,
})
