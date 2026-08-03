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
import { replyToThread } from '../../../core/slack/post.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--channel_id', type: 'str' }),
    new Option({ long: '--ts', type: 'str' }),
    new Option({ long: '--text', type: 'str' }),
  ] })

async function slackReplyToThreadCommand(
  accessor: SlackAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const channelId = opts.flags.channel_id
  const ts = opts.flags.ts
  const text = opts.flags.text
  if (typeof channelId !== 'string' || channelId === '') {
    throw new Error('--channel_id is required')
  }
  if (typeof ts !== 'string' || ts === '') {
    throw new Error('--ts is required')
  }
  if (typeof text !== 'string' || text === '') {
    throw new Error('--text is required')
  }
  const result = await replyToThread(accessor, channelId, ts, text)
  return [ENC.encode(JSON.stringify(result)), new IOResult()]
}

export const SLACK_REPLY_TO_THREAD = command({
  name: 'slack-reply-to-thread',
  resource: ResourceName.SLACK,
  spec: SPEC,
  fn: slackReplyToThreadCommand,
  write: true })
