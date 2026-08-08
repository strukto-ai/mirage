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

import { CLISpec, Operand, Option, registerCliSpec } from '@struktoai/mirage-core'
import { EmailConfigSchema } from '../../../../core/email/config.ts'
import { compose } from './compose.ts'
import { forward } from './forward.ts'
import { listEnvelopes } from './list.ts'
import { read } from './read.ts'
import { reply } from './reply.ts'
import { searchEnvelopes } from './search.ts'
import { send } from './send.ts'

// The himalaya program tree, tracking github.com/pimalaya/himalaya's own
// grammar: `envelope list|search` to triage, `message read/compose/send/
// reply/forward` to act. Messages are addressed by positional id, the
// mailbox by -m/--mailbox, and the built-in flag composer writes RFC 5322
// to stdout unless --send is passed. Install with a per-account
// EmailConfig; two installs under different head words are two accounts.
const ID = new Operand({ type: 'str' })
const MAILBOX = new Option({
  short: '-m',
  long: '--mailbox',
  type: 'str',
  description: 'Mailbox name (default: INBOX)',
})
const PAGE = new Option({
  short: '-p',
  long: '--page',
  type: 'int',
  description: 'Page number, starting from 1',
})
const PAGE_SIZE = new Option({
  short: '-s',
  long: '--page-size',
  type: 'int',
  description: 'Maximum envelopes per page',
})

// The built-in flag composer, shared verbatim by compose, reply and
// forward: upstream flattens the same clap struct into all three.
const COMPOSER = [
  new Option({ long: '--from', type: 'str', description: 'Sender address' }),
  new Option({
    short: '-t',
    long: '--to',
    type: 'str',
    multiple: true,
    description: 'Recipient address(es), repeatable or comma-separated',
  }),
  new Option({
    long: '--cc',
    type: 'str',
    multiple: true,
    description: 'Carbon-copy recipient(s)',
  }),
  new Option({
    long: '--bcc',
    type: 'str',
    multiple: true,
    description: 'Blind carbon-copy recipient(s)',
  }),
  new Option({ short: '-s', long: '--subject', type: 'str', description: 'Subject line' }),
  new Option({ long: '--body', type: 'str', description: 'Inline body (or pipe via stdin)' }),
  new Option({
    long: '--attach',
    type: 'path',
    multiple: true,
    description: 'Attachment file(s), repeatable',
  }),
  new Option({
    long: '--signature',
    type: 'str',
    description: "Signature appended after a '-- ' line",
  }),
  new Option({
    long: '--send',
    description: 'Send through SMTP instead of writing MIME to stdout',
  }),
]

const QUOTING = [
  new Option({
    short: '-P',
    long: '--posting-style',
    type: 'str',
    choices: ['top', 'bottom'],
    default: 'top',
    description: 'Quoted source above or below your body',
  }),
  new Option({
    short: '-Q',
    long: '--quote-headline',
    type: 'str',
    description: 'Literal line placed before the quoted body',
  }),
]

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
          aliases: ['ls'],
          description: 'List envelopes as JSON headers',
          fn: listEnvelopes,
          options: [MAILBOX, PAGE, PAGE_SIZE],
        }),
        new CLISpec({
          name: 'search',
          aliases: ['sr'],
          description: 'Search envelopes with the query DSL',
          fn: searchEnvelopes,
          options: [MAILBOX, PAGE, PAGE_SIZE],
          rest: ID,
          epilog:
            'Conditions: date <yyyy-mm-dd>, before <yyyy-mm-dd>, after ' +
            '<yyyy-mm-dd>, from <pattern>, to <pattern>, subject <pattern>, ' +
            'body <pattern>, flag ' +
            '<seen|answered|flagged|draft|deleted>. Combine with and, or, not; ' +
            'group with parentheses. Sort with order by <date|from|to|subject> [asc|desc].',
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
            MAILBOX,
            new Option({ long: '--raw', description: 'Write the RFC 5322 bytes instead' }),
          ],
          rest: ID,
        }),
        new CLISpec({
          name: 'compose',
          aliases: ['write', 'new'],
          description: 'Compose a new message from flags',
          fn: compose,
          write: true,
          options: COMPOSER,
        }),
        new CLISpec({
          name: 'send',
          description: 'Send a raw RFC 5322 message',
          fn: send,
          write: true,
          rest: ID,
        }),
        new CLISpec({
          name: 'reply',
          description: 'Reply to a message',
          fn: reply,
          write: true,
          options: [MAILBOX, ...COMPOSER, ...QUOTING],
          rest: ID,
        }),
        new CLISpec({
          name: 'forward',
          aliases: ['fwd'],
          description: 'Forward a message',
          fn: forward,
          write: true,
          options: [MAILBOX, ...COMPOSER, ...QUOTING],
          rest: ID,
        }),
      ],
    }),
  ],
})

registerCliSpec(HIMALAYA)
