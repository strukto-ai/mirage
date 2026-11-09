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

import { CLI, CLIHandler } from '../../types.ts'
import { Argument } from '../../../spec/index.ts'
import { CommandSpec, UsageStyle } from '../../../spec/types.ts'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { EmailConfig } from '../../../../core/email/config.ts'
import { attachmentDownload, attachmentList } from './attachment.ts'
import { compose } from './compose.ts'
import { messageDelete } from './delete.ts'
import { flagAdd, flagRemove, flagSet } from './flag.ts'
import { mailboxList } from './mailbox.ts'
import { messageCopy, messageMove } from './transfer.ts'
import { forward } from './forward.ts'
import { listEnvelopes } from './list.ts'
import { read } from './read.ts'
import { reply } from './reply.ts'
import { searchEnvelopes } from './search.ts'
import { guarded } from './printer.ts'
import { add, send } from './send.ts'

// The himalaya program tree, tracking github.com/pimalaya/himalaya's own
// grammar: `envelope list|search` to triage, `message read/compose/send/
// reply/forward/add` to act. Operand names are upstream's, since a refusal
// for a missing one prints them. Install with a per-account EmailConfig;
// two installs under different head words are two accounts.
const JSON_FLAG = new Argument('--json', { action: 'store_true', help: 'Enable JSON output' })
const MAILBOX = new Argument(['-m', '--mailbox'], {
  metavar: 'NAME',
  help: 'Mailbox name, alias, role or backend-native id',
})
const PAGE = new Argument(['-p', '--page'], {
  type: 'int',
  metavar: 'N',
  help: 'Page number, starting at 1',
})
const PAGE_SIZE = new Argument(['-s', '--page-size'], {
  type: 'int',
  metavar: 'N',
  help: 'Maximum number of envelopes per page',
})
const MAX_WIDTH = new Argument(['-w', '--max-width'], {
  type: 'int',
  metavar: 'COLUMNS',
  help: 'Maximum width of the rendered table, in terminal columns',
})
const RECIPIENT = new Argument(['-r', '--recipient'], {
  action: 'store_true',
  help: 'Render recipients instead of senders',
})
const HAS_ATTACHMENT = new Argument('--has-attachment', {
  action: 'store_true',
  help: 'Fill the ATT column',
})
const MESSAGE_IDS = new Argument('MESSAGE-IDS', { nargs: '*' })
const MESSAGE_ID = new Argument('MESSAGE-ID')
const ID = new Argument('ID')
const RAW_MESSAGE = new Argument('MESSAGE', { nargs: 'REMAINDER' })
const SAVE = new Argument('--save', {
  metavar: 'MAILBOX',
  help: 'Append a copy of the message to this mailbox',
})
const NO_SAVE = new Argument('--no-save', {
  action: 'store_true',
  help: 'Skip the copy the account configures',
})

// The built-in flag composer, shared verbatim by compose, reply and
// forward: upstream flattens the same clap struct into all three.
const COMPOSER: readonly Argument[] = [
  new Argument('--from', { metavar: 'ADDR', help: 'Sender address' }),
  new Argument(['-t', '--to'], {
    action: 'append',
    metavar: 'ADDR',
    help: 'Recipient addresses, repeatable or comma-separated',
  }),
  new Argument('--cc', { action: 'append', metavar: 'ADDR', help: 'Carbon-copy recipients' }),
  new Argument('--bcc', {
    action: 'append',
    metavar: 'ADDR',
    help: 'Blind carbon-copy recipients',
  }),
  new Argument(['-s', '--subject'], { metavar: 'TEXT', help: 'Subject line' }),
  new Argument('--body', { metavar: 'TEXT', help: 'Inline body (or pipe via stdin)' }),
  new Argument('--body-file', {
    type: 'path',
    metavar: 'PATH',
    help: 'Read the body from a file',
  }),
  new Argument('--attach', {
    type: 'path',
    action: 'append',
    metavar: 'PATH',
    help: 'Files to attach',
  }),
  new Argument('--signature', { metavar: 'TEXT', help: 'Signature appended after the body' }),
  new Argument('--signature-file', {
    type: 'path',
    metavar: 'PATH',
    help: 'Read the signature from a file',
  }),
  SAVE,
  NO_SAVE,
  new Argument('--send', { action: 'store_true', help: 'Send the composed message' }),
]
const QUOTING: readonly Argument[] = [
  new Argument(['-P', '--posting-style'], {
    choices: ['top', 'bottom', 'none'],
    default: 'top',
    metavar: 'STYLE',
    help: 'Where the quoted source body sits relative to the written one',
  }),
  new Argument(['-Q', '--quote-headline'], {
    metavar: 'TEXT',
    help: 'Plain-text headline placed before the quoted source body',
  }),
]

// Upstream spells both of a message's mailboxes as options on copy and move,
// and takes flags as a repeated option limited to the four every backend has.
const SOURCE = new Argument(['-f', '--from'], {
  help: 'Source mailbox (default: INBOX)',
  metavar: 'NAME',
})
const TARGET = new Argument(['-t', '--to'], {
  required: true,
  help: 'Destination mailbox',
  metavar: 'NAME',
})
const FLAGS = new Argument(['-f', '--flag'], {
  action: 'append',
  required: true,
  choices: ['seen', 'answered', 'flagged', 'draft'],
  metavar: 'FLAG',
  help: 'The flags to apply, the option repeating for several',
})
const ADD_FLAGS = new Argument(['-f', '--flag'], {
  action: 'append',
  choices: ['seen', 'answered', 'flagged', 'draft'],
  metavar: 'FLAG',
  help: 'The flags to set on the added message',
})

export const HIMALAYA = new CLI({
  spec: new CommandSpec({
    name: 'himalaya',
    description: 'CLI to manage emails',
    usageStyle: UsageStyle.CLAP,
    arguments: [JSON_FLAG],
    subcommands: [
      new CommandSpec({
        name: 'mailbox',
        description: 'Manage mailboxes',
        arguments: [JSON_FLAG],
        subcommands: [
          new CommandSpec({
            name: 'list',
            aliases: ['ls'],
            description: 'List the mailboxes of the account',
            arguments: [
              JSON_FLAG,
              new Argument('--counts', {
                action: 'store_true',
                help: 'Fill the total and unread counts',
              }),
              new Argument(['-w', '--max-width'], {
                type: 'int',
                metavar: 'COLUMNS',
                help: 'Maximum width of the rendered table, in terminal columns',
              }),
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'flag',
        description: 'Manage message flags',
        arguments: [JSON_FLAG],
        subcommands: [
          new CommandSpec({
            name: 'add',
            description: 'Add flags to messages',
            arguments: [JSON_FLAG, MAILBOX, FLAGS, MESSAGE_IDS],
          }),
          new CommandSpec({
            name: 'set',
            description: 'Replace the flags of messages',
            arguments: [JSON_FLAG, MAILBOX, FLAGS, MESSAGE_IDS],
          }),
          new CommandSpec({
            name: 'remove',
            aliases: ['rm'],
            description: 'Remove flags from messages',
            arguments: [JSON_FLAG, MAILBOX, FLAGS, MESSAGE_IDS],
          }),
        ],
      }),
      new CommandSpec({
        name: 'attachment',
        description: 'Manage message attachments',
        arguments: [JSON_FLAG],
        subcommands: [
          new CommandSpec({
            name: 'list',
            aliases: ['ls'],
            description: 'List the attachments of one message',
            arguments: [
              JSON_FLAG,
              MAILBOX,
              new Argument(['-i', '--inline'], {
                action: 'store_true',
                help: 'Also list inline parts',
              }),
              MESSAGE_ID,
            ],
          }),
          new CommandSpec({
            name: 'download',
            aliases: ['dl'],
            description: "Save a message's attachments to the workspace",
            arguments: [
              JSON_FLAG,
              MAILBOX,
              new Argument(['-d', '--dir'], {
                type: 'path',
                metavar: 'PATH',
                help: 'Destination directory (default: cwd)',
              }),
              MESSAGE_ID,
              new Argument('ATTACHMENT-ID', { nargs: '*' }),
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'envelope',
        description: 'Manage envelopes',
        arguments: [JSON_FLAG],
        subcommands: [
          new CommandSpec({
            name: 'list',
            aliases: ['ls'],
            description: 'List the envelopes of a mailbox, most recent first',
            arguments: [JSON_FLAG, MAILBOX, PAGE, PAGE_SIZE, MAX_WIDTH, RECIPIENT, HAS_ATTACHMENT],
          }),
          new CommandSpec({
            name: 'search',
            aliases: ['sr'],
            description: 'Search envelopes with the query DSL',
            epilog:
              'Conditions: date <yyyy-mm-dd>, after <yyyy-mm-dd>, from <pattern>, to <pattern>, subject <pattern>, body <pattern>, flag <seen|answered|flagged|draft>. Combine with and, or, not; group with parentheses. Sort with order by <date|from|to|subject> [asc|desc].',
            arguments: [
              JSON_FLAG,
              MAILBOX,
              PAGE,
              PAGE_SIZE,
              MAX_WIDTH,
              RECIPIENT,
              HAS_ATTACHMENT,
              new Argument('QUERY', { nargs: '*' }),
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'message',
        aliases: ['msg'],
        description: 'Manage messages',
        arguments: [JSON_FLAG],
        subcommands: [
          new CommandSpec({
            name: 'copy',
            aliases: ['cp'],
            description: 'Copy messages to another mailbox',
            arguments: [JSON_FLAG, SOURCE, TARGET, MESSAGE_IDS],
          }),
          new CommandSpec({
            name: 'move',
            aliases: ['mv'],
            description: 'Move messages to another mailbox',
            arguments: [JSON_FLAG, SOURCE, TARGET, MESSAGE_IDS],
          }),
          new CommandSpec({
            name: 'delete',
            aliases: ['rm'],
            description: 'Move messages to the trash, or remove them once they are there',
            arguments: [JSON_FLAG, MAILBOX, MESSAGE_IDS],
          }),
          new CommandSpec({
            name: 'read',
            description: 'Read a message',
            arguments: [
              JSON_FLAG,
              MAILBOX,
              new Argument('--raw', {
                action: 'store_true',
                help: 'Write the raw RFC 5322 bytes to stdout',
              }),
              new Argument('--seen', {
                action: 'store_true',
                help: 'Mark the message as seen',
              }),
              ID,
            ],
          }),
          new CommandSpec({
            name: 'compose',
            aliases: ['write', 'new'],
            description: 'Compose a new message from flags',
            arguments: [JSON_FLAG, ...COMPOSER],
          }),
          new CommandSpec({
            name: 'send',
            description: 'Send a message through the account',
            arguments: [JSON_FLAG, SAVE, NO_SAVE, RAW_MESSAGE],
          }),
          new CommandSpec({
            name: 'add',
            aliases: ['save'],
            description: 'Add a raw RFC 5322 message to a mailbox',
            arguments: [
              JSON_FLAG,
              new Argument(['-m', '--mailbox'], {
                required: true,
                metavar: 'NAME',
                help: 'Mailbox to add the message to',
              }),
              ADD_FLAGS,
              new Argument('--send', { action: 'store_true', help: 'Also send the message' }),
              RAW_MESSAGE,
            ],
          }),
          new CommandSpec({
            name: 'reply',
            description: 'Reply to a message',
            arguments: [JSON_FLAG, MAILBOX, ...COMPOSER, ...QUOTING, ID],
          }),
          new CommandSpec({
            name: 'forward',
            aliases: ['fwd'],
            description: 'Forward a message',
            arguments: [JSON_FLAG, MAILBOX, ...COMPOSER, ...QUOTING, ID],
          }),
        ],
      }),
    ],
  }),
  handlers: {
    'mailbox list': new CLIHandler({ fn: guarded(mailboxList) }),
    'flag add': new CLIHandler({ fn: guarded(flagAdd), write: true }),
    'flag set': new CLIHandler({ fn: guarded(flagSet), write: true }),
    'flag remove': new CLIHandler({ fn: guarded(flagRemove), write: true }),
    'attachment list': new CLIHandler({ fn: guarded(attachmentList) }),
    'attachment download': new CLIHandler({ fn: guarded(attachmentDownload), write: true }),
    'message copy': new CLIHandler({ fn: guarded(messageCopy), write: true }),
    'message move': new CLIHandler({ fn: guarded(messageMove), write: true }),
    'message delete': new CLIHandler({ fn: guarded(messageDelete), write: true }),
    'envelope list': new CLIHandler({ fn: guarded(listEnvelopes) }),
    'envelope search': new CLIHandler({ fn: guarded(searchEnvelopes) }),
    'message read': new CLIHandler({ fn: guarded(read) }),
    'message compose': new CLIHandler({ fn: guarded(compose), write: true }),
    'message send': new CLIHandler({ fn: guarded(send), write: true }),
    'message add': new CLIHandler({ fn: guarded(add), write: true }),
    'message reply': new CLIHandler({ fn: guarded(reply), write: true }),
    'message forward': new CLIHandler({ fn: guarded(forward), write: true }),
  },
  configModel: EmailConfig,
  accessor: (config) => new EmailAccessor(config as EmailConfig),
})
