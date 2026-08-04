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

import { FlagView } from '../../../spec/types.ts'
import { addReaction } from '../../../../core/slack/react.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIVerbOpts } from '../../types.ts'
import { slackAccessor } from './accessor.ts'

const ENC = new TextEncoder()

export async function react(
  config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  const result = await addReaction(
    slackAccessor(config),
    fl.asStr('channel') ?? '',
    fl.asStr('ts') ?? '',
    fl.asStr('emoji') ?? '',
  )
  const out: ByteSource = ENC.encode(JSON.stringify(result))
  return [out, new IOResult()]
}
