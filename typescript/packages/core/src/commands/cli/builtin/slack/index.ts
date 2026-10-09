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
import { CommandSpec } from '../../../spec/types.ts'
import { CLI } from '../../types.ts'
import { CLIHandler } from '../../types.ts'

import { SlackConfigSchema } from '../../../../core/slack/config.ts'

import { Argument } from '../../../spec/types.ts'
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
export const SLACK = new CLI({
  spec: new CommandSpec({
    name: 'slack',
    description: 'Slack Web API client',
    subcommands: [
      new CommandSpec({
        name: 'send-message',
        description: 'Post a message to a channel or thread',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--text', { required: true }),
          new Argument('--thread-ts', { help: 'Reply in this thread' }),
        ],
      }),
      new CommandSpec({
        name: 'read-messages',
        description: 'Read the most recent messages of a channel',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--limit', { type: 'int', help: 'Max messages (default: 20)' }),
        ],
      }),
      new CommandSpec({
        name: 'react',
        description: 'Add an emoji reaction to a message',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--ts', { required: true }),
          new Argument('--emoji', { required: true, help: 'Emoji name without colons' }),
        ],
      }),
      new CommandSpec({
        name: 'reactions',
        description: 'List the reactions on a message',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--ts', { required: true }),
        ],
      }),
      new CommandSpec({
        name: 'pin-message',
        description: 'Pin a message to its channel',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--ts', { required: true }),
        ],
      }),
      new CommandSpec({
        name: 'unpin-message',
        description: 'Remove a pin from a message',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--ts', { required: true }),
        ],
      }),
      new CommandSpec({
        name: 'list-pins',
        description: 'List the pinned items of a channel',
        arguments: [new Argument('--channel', { required: true })],
      }),
      new CommandSpec({
        name: 'member-info',
        description: "Fetch one user's profile",
        arguments: [new Argument('--user', { required: true })],
      }),
      new CommandSpec({
        name: 'list-members',
        description: 'List workspace members, optionally filtered',
        arguments: [new Argument('--query', { help: 'Name or email filter' })],
      }),
      new CommandSpec({ name: 'emoji-list', description: "List the workspace's custom emoji" }),
      new CommandSpec({
        name: 'search',
        description: 'Search messages with Slack query operators',
        arguments: [
          new Argument('--query', {
            required: true,
            help: "Slack search query (supports operators like 'from:@user', 'in:#channel')",
          }),
          new Argument('--count', { type: 'int', help: 'Results per page (1-100, default 20)' }),
          new Argument('--page', { type: 'int', help: '1-based page number (default 1)' }),
        ],
      }),
    ],
  }),
  handlers: {
    'send-message': new CLIHandler({ fn: sendMessage, write: true }),
    'read-messages': new CLIHandler({ fn: readMessages }),
    react: new CLIHandler({ fn: react, write: true }),
    reactions: new CLIHandler({ fn: reactions }),
    'pin-message': new CLIHandler({ fn: pinMessage, write: true }),
    'unpin-message': new CLIHandler({ fn: unpinMessage, write: true }),
    'list-pins': new CLIHandler({ fn: listPins }),
    'member-info': new CLIHandler({ fn: memberInfo }),
    'list-members': new CLIHandler({ fn: listMembers }),
    'emoji-list': new CLIHandler({ fn: emojiList }),
    search: new CLIHandler({ fn: search }),
  },
  configModel: SlackConfigSchema,
})
