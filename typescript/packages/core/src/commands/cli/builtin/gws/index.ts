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

import { GoogleConfigSchema } from '../../../../core/google/config.ts'
import { ResourceName } from '../../../../types.ts'
import { CLISpec } from '../../types.ts'
import { Option } from '../../../spec/types.ts'
import { apiGroups } from './api.ts'
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
export const GWS = new CLISpec({
  name: 'gws',
  description: 'Google Workspace API commands',
  configModel: GoogleConfigSchema,
  serves: [
    ResourceName.GDRIVE,
    ResourceName.GDOCS,
    ResourceName.GSHEETS,
    ResourceName.GSLIDES,
    ResourceName.GMAIL,
  ],
  subcommands: [
    new CLISpec({
      name: 'drive',
      description: 'Google drive API commands',
      subcommands: apiGroups('drive'),
    }),
    new CLISpec({
      name: 'sheets',
      description: 'Google sheets API commands',
      subcommands: [
        ...apiGroups('sheets'),
        new CLISpec({
          name: 'read',
          description: 'Read a cell range',
          fn: sheetsRead,
          options: [
            new Option({ long: '--spreadsheet', type: 'str', required: true }),
            new Option({ long: '--range', type: 'str', required: true }),
          ],
        }),
        new CLISpec({
          name: 'write',
          description: 'Overwrite a range with 2D values',
          fn: sheetsWrite,
          write: true,
          options: [
            new Option({ long: '--spreadsheet', type: 'str', required: true }),
            new Option({ long: '--range', type: 'str', required: true }),
            new Option({ long: '--values', type: 'str' }),
            new Option({ long: '--json-values', type: 'str' }),
          ],
        }),
        new CLISpec({
          name: 'append',
          description: 'Append rows after a range',
          fn: sheetsAppend,
          write: true,
          options: [
            new Option({ long: '--spreadsheet', type: 'str', required: true }),
            new Option({ long: '--range', type: 'str' }),
            new Option({ long: '--values', type: 'str' }),
            new Option({ long: '--json-values', type: 'str' }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'docs',
      description: 'Google docs API commands',
      subcommands: [
        ...apiGroups('docs'),
        new CLISpec({
          name: 'write',
          description: 'Append text to a document',
          fn: docsWrite,
          write: true,
          options: [
            new Option({ long: '--document', type: 'str', required: true }),
            new Option({ long: '--text', type: 'str', required: true }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'slides',
      description: 'Google slides API commands',
      subcommands: apiGroups('slides'),
    }),
    new CLISpec({
      name: 'calendar',
      description: 'Google calendar API commands',
      subcommands: apiGroups('calendar'),
    }),
    new CLISpec({
      name: 'forms',
      description: 'Google forms API commands',
      subcommands: apiGroups('forms'),
    }),
    new CLISpec({
      name: 'gmail',
      description: 'Google gmail API commands',
      subcommands: [
        ...apiGroups('gmail'),
        new CLISpec({
          name: 'send',
          description: 'Send a new email via Gmail',
          fn: send,
          write: true,
          options: [
            new Option({ long: '--to', type: 'str', required: true }),
            new Option({ long: '--subject', type: 'str', required: true }),
            new Option({ long: '--body', type: 'str', required: true }),
          ],
        }),
        new CLISpec({
          name: 'read',
          description:
            'Fetch one Gmail message as processed JSON (same shape as cat <path>.gmail.json)',
          fn: read,
          options: [new Option({ long: '--id', type: 'str', required: true })],
        }),
        new CLISpec({
          name: 'reply',
          description: 'Reply to the sender of a Gmail message (excludes CC)',
          fn: reply,
          write: true,
          options: [
            new Option({ long: '--message-id', type: 'str', required: true }),
            new Option({ long: '--body', type: 'str', required: true }),
          ],
        }),
        new CLISpec({
          name: 'reply-all',
          description: 'Reply to a Gmail message including all recipients (To+CC)',
          fn: replyAll,
          write: true,
          options: [
            new Option({ long: '--message-id', type: 'str', required: true }),
            new Option({ long: '--body', type: 'str', required: true }),
          ],
        }),
        new CLISpec({
          name: 'forward',
          description: 'Forward a Gmail message to a new recipient',
          fn: forward,
          write: true,
          options: [
            new Option({ long: '--message-id', type: 'str', required: true }),
            new Option({ long: '--to', type: 'str', required: true }),
          ],
        }),
        new CLISpec({
          name: 'triage',
          description:
            'List message summaries (id, from, subject, date, snippet) for a Gmail search query',
          fn: triage,
          options: [
            new Option({
              long: '--query',
              type: 'str',
              description: 'Gmail search query (default: "is:unread")',
            }),
            new Option({
              long: '--max',
              type: 'int',
              description: 'Max results (default: 20)',
            }),
          ],
        }),
      ],
    }),
  ],
})
