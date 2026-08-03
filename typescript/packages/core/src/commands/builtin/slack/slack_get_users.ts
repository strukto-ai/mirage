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

import type { SlackAccessor } from '../../../accessor/slack.ts'
import { searchUsers } from '../../../core/slack/users.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [new Option({ long: '--query', type: 'str' })],
})

async function slackGetUsersCommand(
  accessor: SlackAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = opts.flags.query
  if (typeof query !== 'string' || query === '') {
    throw new Error('--query is required')
  }
  const users = await searchUsers(accessor, query)
  return [ENC.encode(JSON.stringify(users)), new IOResult()]
}

export const SLACK_GET_USERS = command({
  name: 'slack-get-users',
  resource: ResourceName.SLACK,
  spec: SPEC,
  fn: slackGetUsersCommand,
})
