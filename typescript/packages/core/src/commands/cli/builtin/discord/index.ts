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

import { DiscordConfigSchema } from '../../../../core/discord/config.ts'

import { Argument } from '../../../spec/types.ts'
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
export const DISCORD = new CLI({
  spec: new CommandSpec({
    name: 'discord',
    description: 'Discord REST API client',
    subcommands: [
      new CommandSpec({
        name: 'send',
        description: 'Send a message to a channel',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--text', { required: true }),
          new Argument('--reply-to', { help: 'Reply to this message ID' }),
        ],
      }),
      new CommandSpec({
        name: 'read',
        description: 'Read the most recent messages of a channel',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--limit', { type: 'int', help: 'Max messages (default: 20)' }),
        ],
      }),
      new CommandSpec({
        name: 'edit',
        description: 'Edit a message the bot authored',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--message', { required: true }),
          new Argument('--text', { required: true }),
        ],
      }),
      new CommandSpec({
        name: 'delete',
        description: 'Delete a message',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--message', { required: true }),
        ],
      }),
      new CommandSpec({
        name: 'react',
        description: 'Add an emoji reaction to a message',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--message', { required: true }),
          new Argument('--emoji', { required: true, help: 'Unicode emoji or name:id' }),
        ],
      }),
      new CommandSpec({
        name: 'search',
        description: "Search a guild's messages by content",
        arguments: [
          new Argument('--guild', { required: true }),
          new Argument('--query', { required: true }),
          new Argument('--channel', { help: 'Restrict to one channel' }),
        ],
      }),
      new CommandSpec({
        name: 'thread-create',
        description: 'Create a thread, standalone or from a message',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--name', { required: true }),
          new Argument('--message', { help: 'Start the thread from this message' }),
        ],
      }),
      new CommandSpec({
        name: 'poll',
        description: 'Post a poll message to a channel',
        arguments: [
          new Argument('--channel', { required: true }),
          new Argument('--question', { required: true }),
          new Argument('--answer', {
            action: 'append',
            required: true,
            help: 'Answer option (repeatable)',
          }),
          new Argument('--duration', { type: 'int', help: 'Poll lifetime in hours (default: 24)' }),
          new Argument('--multiselect', {
            action: 'store_true',
            help: 'Allow selecting several answers',
          }),
        ],
      }),
      new CommandSpec({
        name: 'members',
        description: "List a guild's members, optionally filtered",
        arguments: [
          new Argument('--guild', { required: true }),
          new Argument('--query', { help: 'Username prefix filter' }),
        ],
      }),
      new CommandSpec({
        name: 'server-info',
        description: "Fetch a guild's metadata",
        arguments: [new Argument('--guild', { required: true })],
      }),
    ],
  }),
  handlers: {
    send: new CLIHandler({ fn: send, write: true }),
    read: new CLIHandler({ fn: read }),
    edit: new CLIHandler({ fn: edit, write: true }),
    delete: new CLIHandler({ fn: deleteVerb, write: true }),
    react: new CLIHandler({ fn: react, write: true }),
    search: new CLIHandler({ fn: search }),
    'thread-create': new CLIHandler({ fn: threadCreate, write: true }),
    poll: new CLIHandler({ fn: poll, write: true }),
    members: new CLIHandler({ fn: members }),
    'server-info': new CLIHandler({ fn: serverInfo }),
  },
  configModel: DiscordConfigSchema,
})
