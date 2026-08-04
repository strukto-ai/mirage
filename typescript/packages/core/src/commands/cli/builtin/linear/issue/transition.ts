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
import type { PathSpec } from '../../../../../types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIVerbOpts } from '../../../types.ts'
import { firstText, linearTransport, resolveIssue, resolveStateId } from '../util.ts'

export async function transition(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags)
  const transport = linearTransport(config)
  const issueId = await resolveIssue(transport, firstText(texts, 'issue key'))
  const stateId = await resolveStateId(transport, fl.asStr('state_id'), fl.asStr('state_name'))
  const issue = await issueUpdate(transport, { issueId, stateId })
  return [toJsonBytes(normalizeIssue(issue)), new IOResult()]
}
