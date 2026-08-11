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

import { describe, expect, it } from 'vitest'
import { listMessageUids, lockMailbox, parseSearchCriteria } from './_client.ts'

// The IMAP criteria string is the cross-language contract: python hands
// it straight to imaplib, node has to rebuild imapflow's search object
// from it. A key this parser fails to understand must throw, never be
// dropped: dropping widens the search and returns the wrong messages.
describe('parseSearchCriteria', () => {
  it('treats an empty or ALL criteria as match-everything', () => {
    expect(parseSearchCriteria('ALL')).toEqual({ all: true })
    expect(parseSearchCriteria('')).toEqual({ all: true })
  })

  it('maps text keys and unquotes their values', () => {
    expect(parseSearchCriteria('FROM "alice"')).toEqual({ from: 'alice' })
    expect(parseSearchCriteria('SUBJECT "quarterly review"')).toEqual({
      subject: 'quarterly review',
    })
    expect(parseSearchCriteria('BODY "refund"')).toEqual({ body: 'refund' })
  })

  it('unescapes quotes inside a value', () => {
    expect(parseSearchCriteria('SUBJECT "say \\"hi\\""')).toEqual({ subject: 'say "hi"' })
  })

  it('maps every flag keyword, with UNSEEN as the negation of SEEN', () => {
    expect(parseSearchCriteria('SEEN')).toEqual({ seen: true })
    expect(parseSearchCriteria('UNSEEN')).toEqual({ seen: false })
    expect(parseSearchCriteria('ANSWERED')).toEqual({ answered: true })
    expect(parseSearchCriteria('FLAGGED')).toEqual({ flagged: true })
    expect(parseSearchCriteria('DRAFT')).toEqual({ draft: true })
    expect(parseSearchCriteria('DELETED')).toEqual({ deleted: true })
  })

  it('reads NOT, which the old flat scanner dropped', () => {
    // Regression: `NOT SEEN` used to parse as {} and match every
    // message, because neither NOT nor SEEN was recognized.
    expect(parseSearchCriteria('NOT SEEN')).toEqual({ not: { seen: true } })
    expect(parseSearchCriteria('NOT FROM "alice"')).toEqual({ not: { from: 'alice' } })
  })

  it('reads OR as a two-armed prefix operator', () => {
    expect(parseSearchCriteria('OR FROM "a" TO "b"')).toEqual({
      or: [{ from: 'a' }, { to: 'b' }],
    })
  })

  it('reads juxtaposition as AND, merging onto one object', () => {
    expect(parseSearchCriteria('FROM "a" SUBJECT "b"')).toEqual({ from: 'a', subject: 'b' })
    expect(parseSearchCriteria('(FROM "a" TO "b")')).toEqual({ from: 'a', to: 'b' })
  })

  it('expresses a colliding AND through De Morgan rather than losing half', () => {
    // imapflow ANDs the keys of one object, so two subjects cannot merge.
    expect(parseSearchCriteria('SUBJECT "a" SUBJECT "b"')).toEqual({
      not: { or: [{ not: { subject: 'a' } }, { not: { subject: 'b' } }] },
    })
  })

  it('nests parenthesised groups under an operator', () => {
    expect(parseSearchCriteria('OR (FROM "a" TO "b") SUBJECT "c"')).toEqual({
      or: [{ from: 'a', to: 'b' }, { subject: 'c' }],
    })
    expect(parseSearchCriteria('NOT (FROM "a" TO "b")')).toEqual({
      not: { from: 'a', to: 'b' },
    })
  })

  it('keeps the sent-date keys distinct from the internal-date ones', () => {
    // The himalaya DSL searches the `Date:` header, so SENT* must not
    // collapse onto the mailbox's received-at keys.
    expect(parseSearchCriteria('SENTON 03-Feb-2026')).toEqual({
      sentOn: new Date(Date.UTC(2026, 1, 3)),
    })
    expect(parseSearchCriteria('SENTSINCE 02-Jan-2026')).toEqual({
      sentSince: new Date(Date.UTC(2026, 0, 2)),
    })
    expect(parseSearchCriteria('SENTBEFORE 02-Jan-2026')).toEqual({
      sentBefore: new Date(Date.UTC(2026, 0, 2)),
    })
  })

  it('parses the three date keys into UTC dates', () => {
    expect(parseSearchCriteria('ON 03-Feb-2026')).toEqual({ on: new Date(Date.UTC(2026, 1, 3)) })
    expect(parseSearchCriteria('SINCE 02-Jan-2026')).toEqual({
      since: new Date(Date.UTC(2026, 0, 2)),
    })
    expect(parseSearchCriteria('BEFORE 02-Jan-2026')).toEqual({
      before: new Date(Date.UTC(2026, 0, 2)),
    })
  })

  it('throws on a key it does not know instead of silently widening', () => {
    expect(() => parseSearchCriteria('LARGER 100')).toThrow('unsupported IMAP search key')
    expect(() => parseSearchCriteria('FROM')).toThrow('truncated')
    expect(() => parseSearchCriteria('(FROM "a"')).toThrow('unbalanced')
  })

  it('refuses a malformed date rather than rolling it over', () => {
    // An unknown month used to default to January and an out-of-range
    // day used to roll into the next month, both silently.
    expect(() => parseSearchCriteria('ON 03-Xxx-2026')).toThrow('bad date')
    expect(() => parseSearchCriteria('ON 32-Jan-2026')).toThrow('bad date')
    expect(() => parseSearchCriteria('SINCE nonsense')).toThrow('bad date')
  })
})

describe('mailbox and search failures', () => {
  it('names the mailbox instead of relaying "Command failed"', async () => {
    const imap = {
      getMailboxLock: () => {
        // imapflow's shape: a bare message plus the server's own words.
        throw Object.assign(new Error('Command failed'), {
          responseText: 'SELECT failed. No such mailbox',
        })
      },
    }
    await expect(lockMailbox(imap as never, 'Nope')).rejects.toThrow("no such mailbox 'Nope'")
  })

  it('rethrows a connection failure rather than blaming the mailbox', async () => {
    const imap = {
      getMailboxLock: () => {
        throw new Error('ECONNRESET')
      },
    }
    await expect(lockMailbox(imap as never, 'INBOX')).rejects.toThrow('ECONNRESET')
  })

  it('does not read a refused search as an empty result', async () => {
    const imap = {
      getMailboxLock: () => ({ release: () => undefined }),
      search: () => false,
    }
    const accessor = { getImap: () => imap }
    await expect(listMessageUids(accessor as never, 'INBOX', 'SEEN')).rejects.toThrow(
      'IMAP rejected the search',
    )
  })
})
