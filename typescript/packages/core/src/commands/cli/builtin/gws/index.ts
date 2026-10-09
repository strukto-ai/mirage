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

import { GoogleConfigSchema } from '../../../../core/google/config.ts'

import { Argument } from '../../../spec/types.ts'
import { apiGroups, apiHandlers } from './api.ts'
import { write as docsWrite } from './docs/write.ts'
import { forward } from './gmail/forward.ts'
import { read } from './gmail/read.ts'
import { reply } from './gmail/reply.ts'
import { replyAll } from './gmail/reply_all.ts'
import { send } from './gmail/send.ts'
import { triage } from './gmail/triage.ts'
import { append as sheetsAppend } from './sheets/append.ts'
import { read as sheetsRead } from './sheets/read.ts'
import { write as sheetsWrite } from './sheets/write.ts'

// The gws program tree, mirroring the official Google Workspace CLI:
// one passthrough leaf per Discovery method (`gws drive files list`,
// speaking --params/--json like the raw API) plus hand-written helper
// verbs directly under their service (`gws gmail send`). The old mount
// registrations spelled the helpers `+send`; the tree does not need the
// marker. Install with a GoogleConfig; two installs are two accounts.
export const GWS = new CLI({
  spec: new CommandSpec({
    name: 'gws',
    description: 'Google Workspace API commands',
    subcommands: [
      new CommandSpec({
        name: 'drive',
        description: 'Google drive API commands',
        subcommands: apiGroups('drive'),
      }),
      new CommandSpec({
        name: 'sheets',
        description: 'Google sheets API commands',
        subcommands: [
          ...apiGroups('sheets'),
          new CommandSpec({
            name: 'read',
            description: 'Read a cell range',
            arguments: [
              new Argument('--spreadsheet', { required: true }),
              new Argument('--range', { required: true }),
            ],
          }),
          new CommandSpec({
            name: 'write',
            description: 'Overwrite a range with 2D values',
            arguments: [
              new Argument('--spreadsheet', { required: true }),
              new Argument('--range', { required: true }),
              new Argument('--values'),
              new Argument('--json-values'),
            ],
          }),
          new CommandSpec({
            name: 'append',
            description: 'Append rows after a range',
            arguments: [
              new Argument('--spreadsheet', { required: true }),
              new Argument('--range'),
              new Argument('--values'),
              new Argument('--json-values'),
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'docs',
        description: 'Google docs API commands',
        subcommands: [
          ...apiGroups('docs'),
          new CommandSpec({
            name: 'write',
            description: 'Append text to a document',
            arguments: [
              new Argument('--document', { required: true }),
              new Argument('--text', { required: true }),
              new Argument('--tab', {
                help: 'Tab to append to, from tabs[].tabProperties.tabId; the first tab when omitted',
              }),
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'slides',
        description: 'Google slides API commands',
        subcommands: apiGroups('slides'),
      }),
      new CommandSpec({
        name: 'calendar',
        description: 'Google calendar API commands',
        subcommands: apiGroups('calendar'),
      }),
      new CommandSpec({
        name: 'forms',
        description: 'Google forms API commands',
        subcommands: apiGroups('forms'),
      }),
      new CommandSpec({
        name: 'gmail',
        description: 'Google gmail API commands',
        subcommands: [
          ...apiGroups('gmail'),
          new CommandSpec({
            name: 'send',
            description: 'Send a new email via Gmail',
            arguments: [
              new Argument('--to', { required: true }),
              new Argument('--subject', { required: true }),
              new Argument('--body', { required: true }),
            ],
          }),
          new CommandSpec({
            name: 'read',
            description:
              'Fetch one Gmail message as processed JSON (same shape as cat <path>.gmail.json)',
            arguments: [new Argument('--id', { required: true })],
          }),
          new CommandSpec({
            name: 'reply',
            description: 'Reply to the sender of a Gmail message (excludes CC)',
            arguments: [
              new Argument('--message-id', { required: true }),
              new Argument('--body', { required: true }),
            ],
          }),
          new CommandSpec({
            name: 'reply-all',
            description: 'Reply to a Gmail message including all recipients (To+CC)',
            arguments: [
              new Argument('--message-id', { required: true }),
              new Argument('--body', { required: true }),
            ],
          }),
          new CommandSpec({
            name: 'forward',
            description: 'Forward a Gmail message to a new recipient',
            arguments: [
              new Argument('--message-id', { required: true }),
              new Argument('--to', { required: true }),
            ],
          }),
          new CommandSpec({
            name: 'triage',
            description:
              'List message summaries (id, from, subject, date, snippet) for a Gmail search query',
            arguments: [
              new Argument('--query', { help: 'Gmail search query (default: "is:unread")' }),
              new Argument('--max', { type: 'int', help: 'Max results (default: 20)' }),
            ],
          }),
        ],
      }),
    ],
  }),
  handlers: {
    ...apiHandlers(),
    'sheets read': new CLIHandler({ fn: sheetsRead }),
    'sheets write': new CLIHandler({ fn: sheetsWrite, write: true }),
    'sheets append': new CLIHandler({ fn: sheetsAppend, write: true }),
    'docs write': new CLIHandler({ fn: docsWrite, write: true }),
    'gmail send': new CLIHandler({ fn: send, write: true }),
    'gmail read': new CLIHandler({ fn: read }),
    'gmail reply': new CLIHandler({ fn: reply, write: true }),
    'gmail reply-all': new CLIHandler({ fn: replyAll, write: true }),
    'gmail forward': new CLIHandler({ fn: forward, write: true }),
    'gmail triage': new CLIHandler({ fn: triage }),
  },
  configModel: GoogleConfigSchema,
})
