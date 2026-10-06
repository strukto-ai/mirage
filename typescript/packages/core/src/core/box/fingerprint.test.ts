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

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { IndexEntry } from '../../cache/index/config.ts'
import { entryToken, readToken, tokenOf } from './fingerprint.ts'

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

const SHA = sha1('hello')

function entry(extra: Record<string, unknown> = {}): IndexEntry {
  return new IndexEntry({
    id: 'F1',
    name: 'a.txt',
    resourceType: 'box/file',
    remoteTime: '2026-04-01T00:00:00+00:00',
    extra,
  })
}

describe('box fingerprint', () => {
  it.each([
    ['absent', null],
    ['empty', ''],
    ['number', 5],
    ['object', {}],
  ] as const)('only a non-empty string is a token (%s)', (_id, value) => {
    expect(tokenOf(value)).toBeNull()
  })

  it('a sha1 string is its own token', () => {
    expect(tokenOf(SHA)).toBe(SHA)
  })

  it('the entry token is the listed sha1', () => {
    expect(entryToken(entry({ sha1: SHA }))).toBe(SHA)
  })

  // modified_at is no content token: two same-size edits in one second
  // share it on the real service.
  it('a sha1-less entry has no token, never its modified stamp', () => {
    expect(entryToken(entry())).toBeNull()
  })

  it('a foreign row with a non-string sha1 has no token', () => {
    expect(entryToken(entry({ sha1: 5 }))).toBeNull()
  })

  it('a read stamps the listed sha1 only when the bytes hash to it', () => {
    expect(readToken(entry({ sha1: SHA }), SHA)).toBe(SHA)
    expect(readToken(entry({ sha1: SHA }), sha1('other'))).toBeNull()
  })

  it('a read through a sha1-less entry stamps nothing', () => {
    expect(readToken(entry(), sha1(''))).toBeNull()
  })
})
