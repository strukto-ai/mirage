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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexEntry } from '../../cache/index/config.ts'
import { CONTENT_HASH } from './constants.ts'
import { entryToken, resultToken, tokenOf } from './fingerprint.ts'

describe('dropbox fingerprint', () => {
  it.each([
    ['hash', 'abc', 'abc'],
    ['empty', '', null],
    ['absent', null, null],
    ['number', 7, null],
    ['list', ['a'], null],
  ] as const)('only a non-empty string is a token (%s)', (_id, value, token) => {
    expect(tokenOf(value)).toBe(token)
  })

  it('an entry token is the content_hash its row carries', () => {
    const row = new IndexEntry({
      id: 'id:a',
      name: 'a',
      resourceType: 'file',
      extra: { [CONTENT_HASH]: 'h' },
    })
    const bare = new IndexEntry({ id: 'id:b', name: 'b', resourceType: 'file' })
    expect([entryToken(row), entryToken(bare)]).toEqual(['h', null])
  })

  it('a result header names its content_hash', () => {
    const raw = JSON.stringify({
      name: 'a',
      server_modified: '2026-01-01T00:00:00Z',
      [CONTENT_HASH]: 'h',
    })
    expect(resultToken(raw)).toBe('h')
  })

  // Never the modified stamp: stat stamps content_hash, so any other kind
  // here would compare unequal forever, or worse, equal by chance.
  it.each([
    ['absent', null],
    ['blank', ''],
    ['unparseable', 'not json'],
    ['not-object', JSON.stringify(['a'])],
    ['no-hash', JSON.stringify({ server_modified: '2026-01-01T00:00:00Z' })],
    ['empty', JSON.stringify({ [CONTENT_HASH]: '' })],
  ] as const)('a result header without a content_hash is no token (%s)', (_id, raw) => {
    expect(resultToken(raw)).toBeNull()
  })

  describe('an unreadable header', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    // Real Dropbox always sends JSON here, so a reply that isn't explains why
    // every fresh read of the file goes cold.
    it('warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(resultToken('not json')).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('Dropbox-API-Result')
    })

    it('stays quiet when the header is absent', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(resultToken(null)).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    })
  })
})
