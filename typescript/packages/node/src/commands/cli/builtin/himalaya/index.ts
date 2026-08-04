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

import { CLISpec, Option, registerCliSpec } from '@struktoai/mirage-core'
import { EmailConfigSchema } from '../../../../core/email/config.ts'
import { forward } from './forward.ts'
import { listEnvelopes } from './list.ts'
import { read } from './read.ts'
import { reply } from './reply.ts'
import { send } from './send.ts'

// The himalaya program tree (github.com/pimalaya/himalaya vocabulary):
// `envelope list` to triage, `message read/send/reply/forward` to act.
// Install with a per-account EmailConfig; two installs under different
// head words are two accounts.
export const HIMALAYA = new CLISpec({
  name: 'himalaya',
  description: 'IMAP/SMTP mail client',
  configModel: EmailConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'envelope',
      description: 'Manage envelopes',
      subcommands: [
        new CLISpec({
          name: 'list',
          description: 'List envelopes as JSON headers',
          fn: listEnvelopes,
          options: [
            new Option({ long: '--folder', type: 'str' }),
            new Option({ long: '--max', type: 'int' }),
            new Option({ long: '--unseen' }),
            new Option({ long: '--subject', type: 'str' }),
            new Option({ long: '--from', type: 'str' }),
            new Option({ long: '--to', type: 'str' }),
            new Option({ long: '--body', type: 'str' }),
            new Option({ long: '--since', type: 'str' }),
            new Option({ long: '--before', type: 'str' }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'message',
      description: 'Manage messages',
      subcommands: [
        new CLISpec({
          name: 'read',
          description: 'Read one message as JSON',
          fn: read,
          options: [
            new Option({ long: '--uid', type: 'str', required: true }),
            new Option({ long: '--folder', type: 'str', required: true }),
          ],
        }),
        new CLISpec({
          name: 'send',
          description: 'Send a new message',
          fn: send,
          write: true,
          options: [
            new Option({ long: '--to', type: 'str', required: true }),
            new Option({ long: '--subject', type: 'str', required: true }),
            new Option({ long: '--body', type: 'str', required: true }),
          ],
        }),
        new CLISpec({
          name: 'reply',
          description: 'Reply to a message',
          fn: reply,
          write: true,
          options: [
            new Option({ long: '--uid', type: 'str', required: true }),
            new Option({ long: '--folder', type: 'str', required: true }),
            new Option({ long: '--body', type: 'str', required: true }),
            new Option({ long: '--all' }),
          ],
        }),
        new CLISpec({
          name: 'forward',
          description: 'Forward a message',
          fn: forward,
          write: true,
          options: [
            new Option({ long: '--uid', type: 'str', required: true }),
            new Option({ long: '--folder', type: 'str', required: true }),
            new Option({ long: '--to', type: 'str', required: true }),
          ],
        }),
      ],
    }),
  ],
})

registerCliSpec(HIMALAYA)
