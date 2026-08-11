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

import { SlackConfigSchema } from '../../../../core/slack/config.ts'
import { registerCliSpec } from '../../specs.ts'
import { CLISpec } from '../../types.ts'
import { Option } from '../../../spec/types.ts'
import { emojiList } from './emoji_list.ts'
import { listMembers } from './list_members.ts'
import { listPins } from './list_pins.ts'
import { memberInfo } from './member_info.ts'
import { pinMessage } from './pin_message.ts'
import { react } from './react.ts'
import { reactions } from './reactions.ts'
import { readMessages } from './read_messages.ts'
import { search } from './search.ts'
import { sendMessage } from './send_message.ts'
import { unpinMessage } from './unpin_message.ts'

// The slack program, spelled with the OpenClaw Slack action vocabulary
// (kebab verbs: send-message, read-messages, pin-message, list-pins,
// member-info, emoji-list). search and list-members are mirage
// extensions carrying over the old mount commands' capabilities.
// Install with a SlackConfig; two installs are two workspaces.
export const SLACK = new CLISpec({
  name: 'slack',
  description: 'Slack Web API client',
  configModel: SlackConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'send-message',
      description: 'Post a message to a channel or thread',
      fn: sendMessage,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--text', type: 'str', required: true }),
        new Option({ long: '--thread-ts', type: 'str', description: 'Reply in this thread' }),
      ],
    }),
    new CLISpec({
      name: 'read-messages',
      description: 'Read the most recent messages of a channel',
      fn: readMessages,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--limit', type: 'int', description: 'Max messages (default: 20)' }),
      ],
    }),
    new CLISpec({
      name: 'react',
      description: 'Add an emoji reaction to a message',
      fn: react,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--ts', type: 'str', required: true }),
        new Option({
          long: '--emoji',
          type: 'str',
          required: true,
          description: 'Emoji name without colons',
        }),
      ],
    }),
    new CLISpec({
      name: 'reactions',
      description: 'List the reactions on a message',
      fn: reactions,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--ts', type: 'str', required: true }),
      ],
    }),
    new CLISpec({
      name: 'pin-message',
      description: 'Pin a message to its channel',
      fn: pinMessage,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--ts', type: 'str', required: true }),
      ],
    }),
    new CLISpec({
      name: 'unpin-message',
      description: 'Remove a pin from a message',
      fn: unpinMessage,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--ts', type: 'str', required: true }),
      ],
    }),
    new CLISpec({
      name: 'list-pins',
      description: 'List the pinned items of a channel',
      fn: listPins,
      options: [new Option({ long: '--channel', type: 'str', required: true })],
    }),
    new CLISpec({
      name: 'member-info',
      description: "Fetch one user's profile",
      fn: memberInfo,
      options: [new Option({ long: '--user', type: 'str', required: true })],
    }),
    new CLISpec({
      name: 'list-members',
      description: 'List workspace members, optionally filtered',
      fn: listMembers,
      options: [new Option({ long: '--query', type: 'str', description: 'Name or email filter' })],
    }),
    new CLISpec({
      name: 'emoji-list',
      description: "List the workspace's custom emoji",
      fn: emojiList,
    }),
    new CLISpec({
      name: 'search',
      description: 'Search messages with Slack query operators',
      fn: search,
      options: [
        new Option({
          long: '--query',
          type: 'str',
          required: true,
          description: "Slack search query (supports operators like 'from:@user', 'in:#channel')",
        }),
        new Option({
          long: '--count',
          type: 'int',
          description: 'Results per page (1-100, default 20)',
        }),
        new Option({ long: '--page', type: 'int', description: '1-based page number (default 1)' }),
      ],
    }),
  ],
})

registerCliSpec(SLACK)
