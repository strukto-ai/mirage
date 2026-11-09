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

import { cliSpecFor } from '@struktoai/mirage-core/commands/cli/specs'
import { compileSpec } from '@struktoai/mirage-core/commands/spec/compile'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailAccessor } from '@struktoai/mirage-core/accessor/email'
import type * as ClientModule from '@struktoai/mirage-core/core/email/client'
import type { fetchMessage } from '@struktoai/mirage-core/core/email/client'
import { fetchHeaders, listMessageUids } from '@struktoai/mirage-core/core/email/client'
import type { EmailConfig } from '@struktoai/mirage-core/core/email/config'
import { EmailVFS } from '@struktoai/mirage-core/vfs/email/email'
import { Workspace } from '../../../../workspace.ts'
import { HIMALAYA } from '@struktoai/mirage-core/commands/cli/builtin/himalaya/index'
import {
  pageSlice,
  parseQuery,
  QueryError,
  sortHeaders,
  uidBudget,
} from '@struktoai/mirage-core/commands/cli/builtin/himalaya/query'

const sendRawMock = vi.hoisted(() => vi.fn())
const listFolderEntriesMock = vi.hoisted(() => vi.fn())
const appendMock = vi.hoisted(() => vi.fn())

vi.mock('@struktoai/mirage-core/commands/cli/builtin/himalaya/smtp', () => ({
  sendRaw: sendRawMock,
}))

// The real `quoteString` rides along: the query compiler spells its
// patterns through it, and a stub would have to re-implement RFC 3501.
vi.mock('@struktoai/mirage-core/core/email/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  listFolderEntries: listFolderEntriesMock,
  fetchRawMessage: vi.fn(() => Promise.resolve(new TextEncoder().encode('From: a@x\r\n\r\nbody'))),
  fetchMessage: vi.fn(() => Promise.resolve(ORIGINAL)),
  listMessageUids: vi.fn(() => Promise.resolve(['1', '2'])),
  fetchHeaders: vi.fn((_accessor: unknown, _folder: string, uids: string[]) =>
    Promise.resolve(uids.map((uid) => HEADERS[uid])),
  ),
}))

const ORIGINAL = {
  subject: 'Quarterly numbers',
  from: { name: 'Alice', email: 'alice@example.com' },
  reply_to: [],
  to: [{ name: '', email: 'me@example.com' }],
  cc: [{ name: '', email: 'bob@example.com' }],
  date: 'Mon, 02 Feb 2026 10:00:00 +0000',
  body_text: 'the numbers',
  body_html: '',
  snippet: '',
  message_id: '<m1@example.com>',
  in_reply_to: null,
  references: ['<m0@example.com>'],
  has_attachments: false,
  attachments: [],
  uid: '7',
  flags: [],
  internalDate: '2026-02-02T10:00:00.000Z',
}

const HEADERS: Record<string, unknown> = {
  '1': { ...ORIGINAL, uid: '1', subject: 'beta', date: 'Mon, 02 Feb 2026 10:00:00 +0000' },
  '2': { ...ORIGINAL, uid: '2', subject: 'alpha', date: 'Tue, 03 Feb 2026 10:00:00 +0000' },
}

const CONFIG: EmailConfig = {
  imapHost: 'h',
  imapPort: 993,
  smtpHost: 'h',
  smtpPort: 587,
  username: 'me@example.com',
  password: 'p',
  useSsl: false,
  maxMessages: 200,
  saveCopy: true,
  sentFolder: null,
  trashFolder: null,
}

// Every --send path now also files the sender's copy over IMAP, so the
// account's IMAP side is stubbed for the whole file: without this the
// verbs would reach for a real connection to host 'h'.
beforeEach(() => {
  listFolderEntriesMock.mockResolvedValue([
    { name: 'INBOX', attributes: [] },
    { name: 'Sent', attributes: ['\\Sent'] },
  ])
  appendMock.mockReset()
  appendMock.mockResolvedValue({ destination: 'Sent' })
  vi.spyOn(EmailAccessor.prototype, 'getImap').mockResolvedValue({
    append: appendMock,
  } as unknown as Awaited<ReturnType<EmailAccessor['getImap']>>)
  vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
})

// vitest 4 hands a second spyOn on an already-spied method the same spy
// with its call history intact, so a per-test count would otherwise see
// every earlier test's close() calls. Restoring after each test gives
// the next beforeEach a fresh spy.
afterEach(() => {
  vi.restoreAllMocks()
})

function leaf(...path: string[]) {
  let node = HIMALAYA.spec
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

describe('himalaya tree', () => {
  it('matches the himalaya vocabulary', () => {
    expect(HIMALAYA.spec.name).toBe('himalaya')
    expect(HIMALAYA.spec.subcommands.map((g) => g.name)).toEqual([
      'mailbox',
      'flag',
      'attachment',
      'envelope',
      'message',
    ])
    expect(leaf('envelope').subcommands.map((v) => v.name)).toEqual(['list', 'search'])
    expect(leaf('message').subcommands.map((v) => v.name)).toEqual([
      'copy',
      'move',
      'delete',
      'read',
      'compose',
      'send',
      'add',
      'reply',
      'forward',
    ])
  })

  it('carries the upstream aliases', () => {
    expect(leaf('envelope', 'list').aliases).toEqual(['ls'])
    expect(leaf('envelope', 'search').aliases).toEqual(['sr'])
    expect(leaf('message', 'compose').aliases).toEqual(['write', 'new'])
    expect(leaf('message', 'forward').aliases).toEqual(['fwd'])
  })

  it('takes the message id as an operand and the mailbox as -m', () => {
    for (const verb of ['read', 'reply', 'forward']) {
      const node = leaf('message', verb)
      expect(compileSpec(node).positional.map((o) => o.names)).toEqual([['ID']])
      expect(compileSpec(node).options.find((o) => o.names.includes('--mailbox'))?.names).toContain(
        '-m',
      )
    }
    expect(compileSpec(leaf('message', 'compose')).rest).toBeNull()
  })

  it('classifies writes and requires no composer flag', () => {
    expect(HIMALAYA.handlers[['envelope', 'list'].join(' ')]?.write).toBe(false)
    expect(HIMALAYA.handlers[['envelope', 'search'].join(' ')]?.write).toBe(false)
    expect(HIMALAYA.handlers[['message', 'read'].join(' ')]?.write).toBe(false)
    for (const verb of ['compose', 'send', 'reply', 'forward']) {
      expect(HIMALAYA.handlers[['message', verb].join(' ')]?.write).toBe(true)
    }
    expect(compileSpec(leaf('message', 'compose')).options.every((o) => !o.required)).toBe(true)
  })

  it('registers itself for YAML resolution at import time', () => {
    expect(cliSpecFor('himalaya')).toBe(HIMALAYA)
  })

  it('applies config defaults through the zod model', () => {
    const model = HIMALAYA.configModel
    if (model === null || typeof model === 'function') throw new Error('expected zod model')
    const parsed = model.parse({ imapHost: 'h', smtpHost: 'h', username: 'u', password: 'p' })
    expect(parsed.imapPort).toBe(993)
    expect(parsed.smtpPort).toBe(587)
    expect(parsed.useSsl).toBe(true)
    expect(parsed.maxMessages).toBe(200)
  })
})

describe('search query DSL', () => {
  it('turns text conditions into quoted IMAP keys', () => {
    expect(parseQuery('from alice').criteria).toBe('FROM "alice"')
    expect(parseQuery('body refund').criteria).toBe('BODY "refund"')
  })

  it('makes and implicit, or prefix, and binds and tighter', () => {
    expect(parseQuery('from a and to b').criteria).toBe('(FROM "a" TO "b")')
    expect(parseQuery('from a or to b').criteria).toBe('OR FROM "a" TO "b"')
    expect(parseQuery('from a and to b or subject c').criteria).toBe(
      'OR (FROM "a" TO "b") SUBJECT "c"',
    )
  })

  it('regroups with parentheses and negates with not', () => {
    expect(parseQuery('from a and (to b or subject c)').criteria).toBe(
      '(FROM "a" OR TO "b" SUBJECT "c")',
    )
    expect(parseQuery('not flag seen').criteria).toBe('NOT SEEN')
  })

  it('asks for the next day since after is strictly greater', () => {
    expect(parseQuery('date 2026-02-03').criteria).toBe('SENTON 03-Feb-2026')
    expect(parseQuery('after 2026-01-01').criteria).toBe('SENTSINCE 02-Jan-2026')
  })

  it('searches the Date header rather than the received-at timestamp', () => {
    // ON/BEFORE/SINCE would match the mailbox internal date, which is
    // the wrong day for imported or delayed mail.
    for (const source of ['date 2026-02-03', 'after 2026-02-03']) {
      expect(parseQuery(source).criteria.startsWith('SENT')).toBe(true)
    }
  })

  it('only fetches the pages asked for under the default order', () => {
    expect(uidBudget(1, 25, [], 200)).toBe(25)
    expect(uidBudget(3, 25, [], 200)).toBe(75)
    expect(uidBudget(0, 25, [], 200)).toBe(25)
  })

  it('caps deep paging and sorted searches at the account window', () => {
    expect(uidBudget(40, 25, [], 200)).toBe(200)
    expect(uidBudget(1, 25, [{ kind: 'subject', descending: false }], 200)).toBe(200)
  })

  it('keeps spaces in a quoted pattern and defuses its keywords', () => {
    expect(parseQuery('subject "and or not"').criteria).toBe('SUBJECT "and or not"')
  })

  it('parses sorters with asc as the default', () => {
    expect(parseQuery('order by subject from desc').sorters).toEqual([
      { kind: 'subject', descending: false },
      { kind: 'from', descending: true },
    ])
  })

  it('names what it expected where it stopped', () => {
    expect(() => parseQuery('sender alice')).toThrow("found 'e' expected `subject`")
    expect(() => parseQuery('before 2026-02-03')).toThrow("found 'e' expected `body`")
    expect(() => parseQuery('date 2026-13-40')).toThrow('date format after `date`')
    expect(() => parseQuery('from alice bogus')).toThrow(QueryError)
  })

  it('treats an unknown flag as a keyword and an open quote as a word', () => {
    expect(parseQuery('flag urgent').criteria).toBe('KEYWORD urgent')
    expect(parseQuery('subject "open').criteria).toBe('SUBJECT "\\"open"')
    expect(parseQuery('order by').sorters).toEqual([])
  })

  it('orders by date descending when no sorter is given', () => {
    const rows = sortHeaders([HEADERS['1'], HEADERS['2']] as Parameters<typeof sortHeaders>[0], [])
    expect(rows.map((r) => r.uid)).toEqual(['2', '1'])
  })

  it('pages counting from one', () => {
    expect(pageSlice([1, 2, 3, 4, 5], 3, 2)).toEqual([5])
    expect(pageSlice([1, 2, 3], 9, 2)).toEqual([])
  })
})

describe('himalaya dispatch', () => {
  it('runs an installed tree end to end', async () => {
    const ws = new Workspace({})
    ws.registerCli('himalaya', HIMALAYA, {
      imapHost: 'h',
      smtpHost: 'h',
      username: 'me@example.com',
      password: 'p',
    })
    const io = await ws.shell('himalaya message compose --to a@b.com --subject Hi --body yo')
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toContain('To: <a@b.com>')
    await ws.close()
  })

  // The email VFS normalizes snake_case; the CLI install used to
  // validate the raw keys against the camelCase schema and reject the
  // very same config block ("unknown config keys: imap_host, ...").
  it('installs from the same snake_case config block the Python side uses', async () => {
    const ws = new Workspace({})
    ws.registerCli('himalaya', HIMALAYA, {
      imap_host: 'h',
      imap_port: 993,
      smtp_host: 'h',
      smtp_port: 587,
      username: 'me@example.com',
      password: 'p',
      use_ssl: true,
    })
    const io = await ws.shell('himalaya message compose --to a@b.com --subject Hi --body yo')
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toContain('To: <a@b.com>')
    await ws.close()
  })

  it('refuses a stray operand of a slot that takes words after -- only', async () => {
    const ws = new Workspace({})
    ws.registerCli('himalaya', HIMALAYA, {
      imapHost: 'h',
      smtpHost: 'h',
      username: 'u',
      password: 'p',
    })
    const io = await ws.shell('himalaya message add 7')
    expect(io.exitCode).toBe(2)
    expect(new TextDecoder().decode(io.stderr)).toBe(
      "error: unexpected argument '7' found\n\nUsage: himalaya message add [OPTIONS] --mailbox <NAME> [-- <MESSAGE>...]\n\nFor more information, try '--help'.\n",
    )
    await ws.close()
  })
})

describe('himalaya writes and a mounted account', () => {
  // The CLI and a mount are two entry points to one account, so a message the CLI
  // files has to show in the mount's listing without waiting out the index
  // TTL. The mailbox here is test state; the VFS, the CLI, the workspace
  // and its caches are the real ones.
  const store = new Map<string, string[]>()
  const added = new Map<string, unknown>()
  let nextUid = 100

  function file(folder: string, raw: Uint8Array): void {
    const subject = /^Subject: (.*?)\r?$/m.exec(new TextDecoder().decode(raw))?.[1] ?? ''
    const uid = String(++nextUid)
    added.set(uid, {
      ...ORIGINAL,
      uid,
      subject,
      date: 'Mon, 14 Sep 2026 10:00:00 +0000',
      internalDate: '2026-09-14T10:00:00.000Z',
    })
    const uids = store.get(folder) ?? []
    uids.push(uid)
    store.set(folder, uids)
  }

  function workspace(): Workspace {
    const ws = new Workspace({
      '/mail': new EmailVFS(CONFIG),
      '/alias': new EmailVFS(CONFIG),
    })
    ws.registerCli('himalaya', HIMALAYA, CONFIG)
    return ws
  }

  async function out(ws: Workspace, line: string): Promise<string> {
    const io = await ws.shell(line)
    expect(io.exitCode, new TextDecoder().decode(io.stderr)).toBe(0)
    return new TextDecoder().decode(io.stdout)
  }

  beforeEach(() => {
    store.clear()
    added.clear()
    nextUid = 100
    file('INBOX', new TextEncoder().encode('Subject: Older\r\n\r\n'))
    vi.mocked(listMessageUids).mockImplementation((_accessor, folder) =>
      Promise.resolve([...(store.get(folder) ?? [])]),
    )
    vi.mocked(fetchHeaders).mockImplementation((_accessor, _folder, uids) =>
      Promise.resolve(
        uids.map((uid) => added.get(uid) ?? HEADERS[uid]) as Awaited<
          ReturnType<typeof fetchMessage>
        >[],
      ),
    )
    appendMock.mockImplementation((folder: string, raw: Uint8Array) => {
      file(folder, raw)
      return Promise.resolve({ destination: folder })
    })
    // The mount lists folders through the client's own LIST, which the
    // module mock above cannot intercept from inside the module.
    vi.spyOn(EmailAccessor.prototype, 'getImap').mockResolvedValue({
      append: appendMock,
      list: () =>
        Promise.resolve([
          { pathAsListed: 'INBOX', flags: new Set<string>() },
          { pathAsListed: 'Sent', flags: new Set(['\\Sent']) },
        ]),
    } as unknown as Awaited<ReturnType<EmailAccessor['getImap']>>)
    sendRawMock.mockResolvedValue({
      to: [{ name: '', email: 'r@example.invalid' }],
      subject: 'Copy',
    })
  })

  afterEach(() => {
    vi.mocked(listMessageUids).mockImplementation(() => Promise.resolve(['1', '2']))
    vi.mocked(fetchHeaders).mockImplementation((_accessor, _folder, uids) =>
      Promise.resolve(
        uids.map((uid) => HEADERS[uid]) as Awaited<ReturnType<typeof fetchMessage>>[],
      ),
    )
  })

  it('a saved message reaches every listed mount of the account', async () => {
    const ws = workspace()
    try {
      expect(await out(ws, 'ls /mail/Sent')).toBe('')
      expect(await out(ws, 'ls /alias/Sent')).toBe('')
      await out(
        ws,
        'himalaya message compose --to r@example.invalid --subject Example --body Hello --save Sent',
      )
      expect(await out(ws, 'ls /mail/Sent')).toBe('2026-09-14\n')
      expect(await out(ws, 'find /alias -type f')).toContain(
        '/alias/Sent/2026-09-14/Example__102.email.json\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('a sent copy lands in a listed folder that already had mail', async () => {
    const ws = workspace()
    try {
      expect(await out(ws, 'ls /mail/INBOX/2026-09-14')).toBe('Older__101.email.json\n')
      await out(
        ws,
        'himalaya message compose --to r@example.invalid --subject Copy --body Hello --send --save INBOX',
      )
      expect(await out(ws, 'ls /mail/INBOX/2026-09-14')).toBe(
        'Copy__102.email.json\nOlder__101.email.json\n',
      )
    } finally {
      await ws.close()
    }
  })
})
