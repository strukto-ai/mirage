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

import { PathSpec } from '@struktoai/mirage-core/types'
import { NAME_MAX_BYTES, byteLength } from '@struktoai/mirage-core/utils/sanitize'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, listMessageUids: vi.fn(), fetchHeaders: vi.fn() }
})

import type { EmailAccessor } from '../../accessor/email.ts'
import * as client from './client.ts'
import { msgFilename } from './readdir.ts'
import { buildSearchCriteria, buildVfsPath, filesContaining } from './search.ts'

const { parseSearchCriteria } = client
const uids = vi.mocked(client.listMessageUids)
const named = vi.mocked(client.fetchHeaders)

const CJK_SUBJECT = '会議の記録'.repeat(40)
const MSG = { subject: CJK_SUBJECT, uid: '7', date: 'Mon, 5 Jan 2026 10:00:00 +0000' }

describe('email search paths', () => {
  it('names the file readdir created', () => {
    // Composed here from a bare `sanitize`, a hit pointed at a path that does
    // not exist as soon as the subject was long enough to be trimmed: readdir
    // budgets the subject against the uid and the suffix, and this did not,
    // so the two names differed.
    const path = buildVfsPath('/mail', 'INBOX', MSG as never)
    expect(path.endsWith(`/${msgFilename(CJK_SUBJECT, '7')}`)).toBe(true)
  })

  it('fits NAME_MAX', () => {
    const name =
      buildVfsPath('/mail', 'INBOX', MSG as never)
        .split('/')
        .pop() ?? ''
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).not.toContain('\uFFFD')
  })
})

describe('buildSearchCriteria', () => {
  it('escapes quotes and backslashes in every text-valued key', () => {
    // A grep pattern holding a quote used to end the quoted string early,
    // so the rest of the pattern was read as IMAP search keys (#1067).
    expect(buildSearchCriteria({ text: 'say "hi"' })).toBe('TEXT "say \\"hi\\""')
    expect(buildSearchCriteria({ subject: 'a\\b' })).toBe('SUBJECT "a\\\\b"')
    expect(buildSearchCriteria({ fromAddr: '"Al" <a@x>' })).toBe('FROM "\\"Al\\" <a@x>"')
    expect(buildSearchCriteria({ toAddr: 'x"y' })).toBe('TO "x\\"y"')
  })

  it('keeps spaces and unicode', () => {
    expect(buildSearchCriteria({ text: 'quarterly review' })).toBe('TEXT "quarterly review"')
    expect(buildSearchCriteria({ subject: '会議の記録' })).toBe('SUBJECT "会議の記録"')
  })

  it('joins keys and leaves dates bare', () => {
    expect(buildSearchCriteria({})).toBe('ALL')
    expect(buildSearchCriteria({ unseen: true, since: '05-Jan-2026', before: '07-Jan-2026' })).toBe(
      'UNSEEN SINCE 05-Jan-2026 BEFORE 07-Jan-2026',
    )
  })

  it('spells a value the client reads back unchanged', () => {
    expect(parseSearchCriteria(buildSearchCriteria({ text: 'say "hi" \\ done' }))).toEqual({
      text: 'say "hi" \\ done',
    })
  })
})

// Twins of the files_containing tests in python/tests/core/email/test_search.py.
describe('filesContaining', () => {
  const accessor = { config: { maxMessages: 200 } } as unknown as EmailAccessor
  const headers = [
    { uid: '3', subject: 'Q2 Budget', date: 'Mon, 5 Jan 2026 10:00 +0000' },
    { uid: '9', subject: '', date: '', internalDate: '06-Jan-2026 09:30:00 +0000' },
  ]
  const scope = (key: string): PathSpec =>
    PathSpec.fromStrPath(`/mail${key}`, key.replace(/^\//, ''))

  beforeEach(() => {
    uids.mockReset().mockResolvedValue(['3', '9'])
    named.mockReset().mockResolvedValue(headers as never)
  })

  // A day is asked for its whole folder; hits on other days are never
  // walked, so naming them costs nothing.
  it.each(['/INBOX', '/INBOX/2026-01-05'])(
    'names the files the folder lists for %s',
    async (key) => {
      const hits = await filesContaining(accessor, 'budget', [scope(key)], false)
      expect(hits?.map((hit) => hit.virtual)).toEqual([
        '/mail/INBOX/2026-01-05/Q2_Budget__3.email.json',
        '/mail/INBOX/2026-01-06/No_Subject__9.email.json',
      ])
      expect(uids.mock.calls[0]?.slice(1, 3)).toEqual(['INBOX', 'TEXT "udget"'])
      expect(named.mock.calls[0]?.[3]).toBe(true)
    },
  )

  it.each([
    ['budget', ''],
    ['budget', '/INBOX/2026-01-05/Q2_Budget__3.email.json'],
    ['subject', '/INBOX'],
    ['seen', '/INBOX'],
    ['deploy 42', '/INBOX'],
  ])('does not ask for %j under %j', async (text, key) => {
    expect(await filesContaining(accessor, text, [scope(key)], false)).toBeNull()
    expect(uids).not.toHaveBeenCalled()
  })

  it('reads a failed search as no answer and no hit as one', async () => {
    uids.mockRejectedValueOnce(new Error('IMAP rejected the search'))
    expect(await filesContaining(accessor, 'budget', [scope('/INBOX')], false)).toBeNull()
    uids.mockResolvedValueOnce([])
    named.mockResolvedValueOnce([])
    expect(await filesContaining(accessor, 'budget', [scope('/INBOX')], false)).toEqual([])
  })
})
