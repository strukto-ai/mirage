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

import { issueUpdate } from '../../../../../core/linear/_client.ts'
import { normalizeIssue, toJsonBytes } from '../../../../../core/linear/normalize.ts'
import { FlagView } from '../../../../spec/types.ts'
import { IOResult } from '../../../../../io/types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIInvocation } from '../../../types.ts'
import { firstText, linearTransport, resolveIssue } from '../util.ts'

export async function setPriority(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = linearTransport(inv.config)
  const issueId = await resolveIssue(transport, firstText(inv.texts, 'issue key'))
  const issue = await issueUpdate(transport, {
    issueId,
    priority: fl.asInt('priority') ?? 0,
  })
  return [toJsonBytes(normalizeIssue(issue)), new IOResult()]
}
