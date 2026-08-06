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
import { fetchRecentMessages } from '../../../../core/slack/history.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { slackAccessor } from './accessor.ts'

const ENC = new TextEncoder()

export async function readMessages(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const messages = await fetchRecentMessages(
    slackAccessor(inv.config),
    fl.asStr('channel') ?? '',
    fl.asInt('limit') ?? 20,
  )
  const out: ByteSource = ENC.encode(JSON.stringify(messages))
  return [out, new IOResult()]
}
