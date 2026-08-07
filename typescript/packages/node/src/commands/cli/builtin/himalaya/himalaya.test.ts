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

import { describe, expect, it, vi } from 'vitest'
import { cliSpecFor, materialize, type IOResult } from '@struktoai/mirage-core'
import { EmailAccessor } from '../../../../accessor/email.ts'
import { Workspace } from '../../../../workspace.ts'
import { build, composeBody, hasPrefix, quoteText, splitAddresses } from './builder.ts'
import { forward } from './forward.ts'
import { HIMALAYA } from './index.ts'
import { listEnvelopes } from './list.ts'
import { pageSlice, parseQuery, QueryError, sortHeaders, uidBudget } from './query.ts'
import { reply } from './reply.ts'
import { searchEnvelopes } from './search.ts'
import { send } from './send.ts'

const sendRawMock = vi.hoisted(() => vi.fn())

vi.mock('./smtp.ts', () => ({ sendRaw: sendRawMock }))

vi.mock('../../../../core/email/_client.ts', () => ({
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
}

const HEADERS: Record<string, unknown> = {
  '1': { ...ORIGINAL, uid: '1', subject: 'beta', date: 'Mon, 02 Feb 2026 10:00:00 +0000' },
  '2': { ...ORIGINAL, uid: '2', subject: 'alpha', date: 'Tue, 03 Feb 2026 10:00:00 +0000' },
}

const CONFIG = {
  imapHost: 'h',
  imapPort: 993,
  smtpHost: 'h',
  smtpPort: 587,
  username: 'me@example.com',
  password: 'p',
  useSsl: false,
  maxMessages: 200,
}

function leaf(...path: string[]) {
  let node = HIMALAYA
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

function decode(out: Uint8Array): string {
  return new TextDecoder().decode(out)
}

describe('himalaya tree', () => {
  it('matches the himalaya vocabulary', () => {
    expect(HIMALAYA.name).toBe('himalaya')
    expect(HIMALAYA.subcommands.map((g) => g.name)).toEqual(['envelope', 'message'])
    expect(leaf('envelope').subcommands.map((v) => v.name)).toEqual(['list', 'search'])
    expect(leaf('message').subcommands.map((v) => v.name)).toEqual([
      'read',
      'compose',
      'send',
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
      expect(node.rest).not.toBeNull()
      expect(node.options.find((o) => o.long === '--mailbox')?.short).toBe('-m')
    }
    expect(leaf('message', 'compose').rest).toBeNull()
  })

  it('classifies writes and requires no composer flag', () => {
    expect(leaf('envelope', 'list').write).toBe(false)
    expect(leaf('envelope', 'search').write).toBe(false)
    expect(leaf('message', 'read').write).toBe(false)
    for (const verb of ['compose', 'send', 'reply', 'forward']) {
      expect(leaf('message', verb).write).toBe(true)
    }
    expect(leaf('message', 'compose').options.every((o) => !o.required)).toBe(true)
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
    expect(parseQuery('before 2026-02-03').criteria).toBe('SENTBEFORE 03-Feb-2026')
    expect(parseQuery('after 2026-01-01').criteria).toBe('SENTSINCE 02-Jan-2026')
  })

  it('searches the Date header rather than the received-at timestamp', () => {
    // ON/BEFORE/SINCE would match the mailbox internal date, which is
    // the wrong day for imported or delayed mail.
    for (const source of ['date 2026-02-03', 'before 2026-02-03', 'after 2026-02-03']) {
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

  it('refuses what it cannot parse', () => {
    expect(() => parseQuery('sender alice')).toThrow(QueryError)
    expect(() => parseQuery('flag urgent')).toThrow(QueryError)
    expect(() => parseQuery('date 2026-13-40')).toThrow(QueryError)
    expect(() => parseQuery('order by')).toThrow(QueryError)
    expect(() => parseQuery('from alice bogus')).toThrow(QueryError)
    expect(() => parseQuery('subject "open')).toThrow(QueryError)
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

describe('message builder', () => {
  it('flattens repeats and comma lists', () => {
    expect(splitAddresses(['a@x, b@x', ' c@x '])).toEqual(['a@x', 'b@x', 'c@x'])
  })

  it('keeps the colon when testing for an existing prefix', () => {
    expect(hasPrefix('Re: hello', 'Re: ')).toBe(true)
    expect(hasPrefix('Ready to ship', 'Re: ')).toBe(false)
  })

  it('quotes each line once and leaves the headline unquoted', () => {
    expect(quoteText('a\nb', '')).toBe('> a\n> b')
    expect(quoteText('> a\nb', '')).toBe('>> a\n> b')
    expect(quoteText('a', 'Alice wrote:')).toBe('Alice wrote:\n> a')
  })

  it('top posts by default and bottom posts on request', () => {
    expect(composeBody('mine', '> theirs', '', 'top')).toBe('mine\n\n> theirs')
    expect(composeBody('mine', '> theirs', '', 'bottom')).toBe('> theirs\n\nmine')
    expect(composeBody('mine', '', 'sig', 'top')).toBe('mine\n\n-- \nsig')
  })

  it('refuses a message with no recipient', () => {
    expect(() =>
      build({
        sender: 'me@x',
        to: [],
        cc: [],
        bcc: [],
        subject: 'Hi',
        body: 'yo',
        signature: null,
      }),
    ).toThrow('no recipient')
  })
})

describe('himalaya verbs', () => {
  it('compose writes MIME to stdout without sending', async () => {
    sendRawMock.mockClear()
    const [out, io] = (await import('./compose.ts').then((m) =>
      m.compose({
        config: CONFIG,
        argv: [],
        paths: [],
        texts: [],
        flags: { to: 'a@b.com', subject: 'Hi', body: 'yo' },
        stdin: null,
        env: {},
      }),
    )) as [Uint8Array, IOResult]
    expect(io.exitCode).toBe(0)
    expect(sendRawMock).not.toHaveBeenCalled()
    const text = decode(await materialize(out))
    expect(text).toContain('From: me@example.com')
    expect(text).toContain('To: a@b.com')
    expect(text).toContain('Subject: Hi')
    expect(text.endsWith('yo\r\n')).toBe(true)
  })

  it('compose --send pushes the raw bytes through SMTP', async () => {
    sendRawMock.mockClear()
    sendRawMock.mockResolvedValue({ to: [{ name: '', email: 'a@b.com' }], subject: 'Hi' })
    const [out] = (await import('./compose.ts').then((m) =>
      m.compose({
        config: CONFIG,
        argv: [],
        paths: [],
        texts: [],
        flags: { to: 'a@b.com', subject: 'Hi', body: 'yo', send: true },
        stdin: null,
        env: {},
      }),
    )) as [Uint8Array, IOResult]
    expect(decode(sendRawMock.mock.calls[0]?.[1] as Uint8Array)).toContain('Subject: Hi')
    expect(JSON.parse(decode(await materialize(out)))).toEqual({
      status: 'sent',
      to: 'a@b.com',
      subject: 'Hi',
    })
  })

  it('reply derives subject, recipients and threading', async () => {
    const closeSpy = vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
    const [out] = (await reply({
      config: CONFIG,
      argv: [],
      paths: [],
      texts: ['7'],
      flags: { body: 'thanks' },
      stdin: null,
      env: {},
    })) as [Uint8Array, IOResult]
    const text = decode(await materialize(out))
    expect(text).toContain('Subject: Re: Quarterly numbers')
    expect(text).toContain('To: Alice <alice@example.com>')
    expect(text).toContain('In-Reply-To: <m1@example.com>')
    expect(text).toContain('References: <m0@example.com> <m1@example.com>')
    expect(text).toContain('thanks\r\n\r\n> the numbers')
    closeSpy.mockRestore()
  })

  it('forward prefixes Fwd and keeps References but not In-Reply-To', async () => {
    const closeSpy = vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
    const [out] = (await forward({
      config: CONFIG,
      argv: [],
      paths: [],
      texts: ['7'],
      flags: { to: 'carol@example.com' },
      stdin: null,
      env: {},
    })) as [Uint8Array, IOResult]
    const text = decode(await materialize(out))
    expect(text).toContain('Subject: Fwd: Quarterly numbers')
    expect(text).not.toContain('In-Reply-To')
    expect(text).toContain('References: <m0@example.com> <m1@example.com>')
    closeSpy.mockRestore()
  })

  it('reply without an id is a usage error', async () => {
    await expect(
      reply({ config: CONFIG, argv: [], paths: [], texts: [], flags: {}, stdin: null, env: {} }),
    ).rejects.toThrow('message id is required')
  })

  it('send reads a raw message from stdin', async () => {
    sendRawMock.mockClear()
    sendRawMock.mockResolvedValue({ to: [{ name: '', email: 'a@b.com' }], subject: 'Hi' })
    const raw = new TextEncoder().encode('From: me@x\nTo: a@b.com\nSubject: Hi\n\nyo')
    const [out] = (await send({
      config: CONFIG,
      argv: [],
      paths: [],
      texts: [],
      flags: {},
      stdin: raw,
      env: {},
    })) as [Uint8Array, IOResult]
    expect(sendRawMock.mock.calls[0]?.[1]).toEqual(raw)
    expect(JSON.parse(decode(await materialize(out)))).toEqual({
      status: 'sent',
      to: 'a@b.com',
      subject: 'Hi',
    })
  })

  it('send refuses an empty message before reaching SMTP', async () => {
    sendRawMock.mockClear()
    await expect(
      send({
        config: CONFIG,
        argv: [],
        paths: [],
        texts: [],
        flags: {},
        stdin: new TextEncoder().encode('  \n '),
        env: {},
      }),
    ).rejects.toThrow('no message provided')
    expect(sendRawMock).not.toHaveBeenCalled()
  })

  it('list orders most recent first and closes its accessor', async () => {
    const closeSpy = vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
    const [out] = (await listEnvelopes({
      config: CONFIG,
      argv: [],
      paths: [],
      texts: [],
      flags: {},
      stdin: null,
      env: {},
    })) as [Uint8Array, IOResult]
    const rows = JSON.parse(decode(await materialize(out))) as { uid: string }[]
    expect(rows.map((r) => r.uid)).toEqual(['2', '1'])
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })

  it('search sorts client side from the query clause', async () => {
    const closeSpy = vi.spyOn(EmailAccessor.prototype, 'close').mockResolvedValue()
    const [out] = (await searchEnvelopes({
      config: CONFIG,
      argv: [],
      paths: [],
      texts: ['order', 'by', 'subject'],
      flags: {},
      stdin: null,
      env: {},
    })) as [Uint8Array, IOResult]
    const rows = JSON.parse(decode(await materialize(out))) as { uid: string }[]
    expect(rows.map((r) => r.uid)).toEqual(['2', '1'])
    closeSpy.mockRestore()
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
    const io = await ws.execute('himalaya message compose --to a@b.com --subject Hi --body yo')
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toContain('To: a@b.com')
    await ws.close()
  })

  // The email resource normalizes snake_case; the CLI install used to
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
    const io = await ws.execute('himalaya message compose --to a@b.com --subject Hi --body yo')
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(io.stdout)).toContain('To: a@b.com')
    await ws.close()
  })

  it('reports an upstream verb mirage lacks with git wording', async () => {
    const ws = new Workspace({})
    ws.registerCli('himalaya', HIMALAYA, {
      imapHost: 'h',
      smtpHost: 'h',
      username: 'u',
      password: 'p',
    })
    const io = await ws.execute('himalaya message move 7 --to Archive')
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(io.stderr)).toBe(
      "himalaya: 'move' is not a himalaya message command. See 'himalaya message --help'.\n",
    )
    await ws.close()
  })
})
