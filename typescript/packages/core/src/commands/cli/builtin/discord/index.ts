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

import { DiscordConfigSchema } from '../../../../core/discord/config.ts'
import { registerCliSpec } from '../../specs.ts'
import { CLISpec } from '../../types.ts'
import { Option } from '../../../spec/types.ts'
import { deleteVerb } from './delete.ts'
import { edit } from './edit.ts'
import { members } from './members.ts'
import { poll } from './poll.ts'
import { react } from './react.ts'
import { read } from './read.ts'
import { search } from './search.ts'
import { send } from './send.ts'
import { serverInfo } from './server_info.ts'
import { threadCreate } from './thread_create.ts'

// The discord program, spelled with the OpenClaw Discord action
// vocabulary (bare verbs: send, read, edit, delete, react, search,
// thread-create, poll). members and server-info are mirage extensions
// carrying over the old mount commands' capabilities. Install with a
// DiscordConfig; two installs are two bots.
export const DISCORD = new CLISpec({
  name: 'discord',
  description: 'Discord REST API client',
  configModel: DiscordConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'send',
      description: 'Send a message to a channel',
      fn: send,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--text', type: 'str', required: true }),
        new Option({ long: '--reply-to', type: 'str', description: 'Reply to this message ID' }),
      ],
    }),
    new CLISpec({
      name: 'read',
      description: 'Read the most recent messages of a channel',
      fn: read,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--limit', type: 'int', description: 'Max messages (default: 20)' }),
      ],
    }),
    new CLISpec({
      name: 'edit',
      description: 'Edit a message the bot authored',
      fn: edit,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--message', type: 'str', required: true }),
        new Option({ long: '--text', type: 'str', required: true }),
      ],
    }),
    new CLISpec({
      name: 'delete',
      description: 'Delete a message',
      fn: deleteVerb,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--message', type: 'str', required: true }),
      ],
    }),
    new CLISpec({
      name: 'react',
      description: 'Add an emoji reaction to a message',
      fn: react,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--message', type: 'str', required: true }),
        new Option({
          long: '--emoji',
          type: 'str',
          required: true,
          description: 'Unicode emoji or name:id',
        }),
      ],
    }),
    new CLISpec({
      name: 'search',
      description: "Search a guild's messages by content",
      fn: search,
      options: [
        new Option({ long: '--guild', type: 'str', required: true }),
        new Option({ long: '--query', type: 'str', required: true }),
        new Option({ long: '--channel', type: 'str', description: 'Restrict to one channel' }),
      ],
    }),
    new CLISpec({
      name: 'thread-create',
      description: 'Create a thread, standalone or from a message',
      fn: threadCreate,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--name', type: 'str', required: true }),
        new Option({
          long: '--message',
          type: 'str',
          description: 'Start the thread from this message',
        }),
      ],
    }),
    new CLISpec({
      name: 'poll',
      description: 'Post a poll message to a channel',
      fn: poll,
      write: true,
      options: [
        new Option({ long: '--channel', type: 'str', required: true }),
        new Option({ long: '--question', type: 'str', required: true }),
        new Option({
          long: '--answer',
          type: 'str',
          required: true,
          multiple: true,
          description: 'Answer option (repeatable)',
        }),
        new Option({
          long: '--duration',
          type: 'int',
          description: 'Poll lifetime in hours (default: 24)',
        }),
        new Option({ long: '--multiselect', description: 'Allow selecting several answers' }),
      ],
    }),
    new CLISpec({
      name: 'members',
      description: "List a guild's members, optionally filtered",
      fn: members,
      options: [
        new Option({ long: '--guild', type: 'str', required: true }),
        new Option({ long: '--query', type: 'str', description: 'Username prefix filter' }),
      ],
    }),
    new CLISpec({
      name: 'server-info',
      description: "Fetch a guild's metadata",
      fn: serverInfo,
      options: [new Option({ long: '--guild', type: 'str', required: true })],
    }),
  ],
})

registerCliSpec(DISCORD)
