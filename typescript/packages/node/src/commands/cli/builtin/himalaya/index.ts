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
import { CLI } from '@struktoai/mirage-core/commands/cli/types'
import { CLIHandler } from '@struktoai/mirage-core/commands/cli/types'

import { registerCliSpec } from '@struktoai/mirage-core/commands/cli/specs'
import { CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { Argument } from '@struktoai/mirage-core/commands/spec/index'
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
const ID = new Argument('text', { metavar: '', nargs: '*' })
const MAILBOX = new Argument(['-m', '--mailbox'], { help: 'Mailbox name (default: INBOX)' })
const PAGE = new Argument(['-p', '--page'], { type: 'int', help: 'Page number, starting from 1' })
const PAGE_SIZE = new Argument(['-s', '--page-size'], {
  type: 'int',
  help: 'Maximum envelopes per page',
})

// Upstream v2 spells the sent copy as an explicit mailbox on every verb
// that produces a message, so `--save` alone files it without sending and
// `--save` with `--send` does both, naming the mailbox the account's
// saveCopy would otherwise resolve on its own.
const SAVE = new Argument('--save', {
  metavar: 'MAILBOX',
  help: 'Append a copy of the message to this mailbox',
})

// The built-in flag composer, shared verbatim by compose, reply and
// forward: upstream flattens the same clap struct into all three.
const COMPOSER = [
  new Argument('--from', { help: 'Sender address' }),
  new Argument(['-t', '--to'], {
    action: 'append',
    help: 'Recipient address(es), repeatable or comma-separated',
  }),
  new Argument('--cc', { action: 'append', help: 'Carbon-copy recipient(s)' }),
  new Argument('--bcc', { action: 'append', help: 'Blind carbon-copy recipient(s)' }),
  new Argument(['-s', '--subject'], { help: 'Subject line' }),
  new Argument('--body', { help: 'Inline body (or pipe via stdin)' }),
  new Argument('--attach', {
    action: 'append',
    type: 'path',
    help: 'Attachment file(s), repeatable',
  }),
  new Argument('--signature', { help: "Signature appended after a '-- ' line" }),
  new Argument('--send', {
    action: 'store_true',
    help: 'Send through SMTP instead of writing MIME to stdout',
  }),
  SAVE,
]

const QUOTING = [
  new Argument(['-P', '--posting-style'], {
    choices: ['top', 'bottom'],
    default: 'top',
    help: 'Quoted source above or below your body',
  }),
  new Argument(['-Q', '--quote-headline'], { help: 'Literal line placed before the quoted body' }),
]

export const HIMALAYA = new CLI({
  spec: new CommandSpec({
    name: 'himalaya',
    description: 'IMAP/SMTP mail client',
    subcommands: [
      new CommandSpec({
        name: 'envelope',
        description: 'Manage envelopes',
        subcommands: [
          new CommandSpec({
            name: 'list',
            aliases: ['ls'],
            description: 'List envelopes as JSON headers',
            arguments: [MAILBOX, PAGE, PAGE_SIZE],
          }),
          new CommandSpec({
            name: 'search',
            aliases: ['sr'],
            description: 'Search envelopes with the query DSL',
            arguments: [MAILBOX, PAGE, PAGE_SIZE, ID],
            epilog:
              'Conditions: date <yyyy-mm-dd>, before <yyyy-mm-dd>, after ' +
              '<yyyy-mm-dd>, from <pattern>, to <pattern>, subject <pattern>, ' +
              'body <pattern>, flag ' +
              '<seen|answered|flagged|draft|deleted>. Combine with and, or, not; ' +
              'group with parentheses. Sort with order by <date|from|to|subject> [asc|desc].',
          }),
        ],
      }),
      new CommandSpec({
        name: 'message',
        description: 'Manage messages',
        subcommands: [
          new CommandSpec({
            name: 'read',
            description: 'Read one message as JSON',
            arguments: [
              MAILBOX,
              new Argument('--raw', {
                action: 'store_true',
                help: 'Write the RFC 5322 bytes instead',
              }),
              ID,
            ],
          }),
          new CommandSpec({
            name: 'compose',
            aliases: ['write', 'new'],
            description: 'Compose a new message from flags',
            arguments: [...COMPOSER],
          }),
          new CommandSpec({
            name: 'send',
            description: 'Send a raw RFC 5322 message',
            arguments: [SAVE, ID],
          }),
          new CommandSpec({
            name: 'reply',
            description: 'Reply to a message',
            arguments: [MAILBOX, ...COMPOSER, ...QUOTING, ID],
          }),
          new CommandSpec({
            name: 'forward',
            aliases: ['fwd'],
            description: 'Forward a message',
            arguments: [MAILBOX, ...COMPOSER, ...QUOTING, ID],
          }),
        ],
      }),
    ],
  }),
  handlers: {
    'envelope list': new CLIHandler({ fn: listEnvelopes }),
    'envelope search': new CLIHandler({ fn: searchEnvelopes }),
    'message read': new CLIHandler({ fn: read }),
    'message compose': new CLIHandler({ fn: compose, write: true }),
    'message send': new CLIHandler({ fn: send, write: true }),
    'message reply': new CLIHandler({ fn: reply, write: true }),
    'message forward': new CLIHandler({ fn: forward, write: true }),
  },
  configModel: EmailConfigSchema,
})

registerCliSpec(HIMALAYA)
