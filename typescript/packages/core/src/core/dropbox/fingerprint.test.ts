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
import { resultToken, tokenOf } from './fingerprint.ts'

describe('dropbox fingerprint', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['hash', 'abc', 'abc'],
    ['empty', '', null],
    ['absent', undefined, null],
    ['number', 7, null],
  ])('takes only a non-empty string as a token (%s)', (_id, value, token) => {
    expect(tokenOf(value)).toBe(token)
  })

  // Never the modified stamp: stat stamps content_hash. Dropbox always sends a
  // JSON object, so anything else warns.
  it.each([
    ['hash', JSON.stringify({ server_modified: 't', content_hash: 'h' }), 'h', false],
    ['absent', null, null, false],
    ['no-hash', JSON.stringify({ server_modified: 't' }), null, false],
    ['not-json', 'not json', null, true],
    ['not-object', JSON.stringify(['a']), null, true],
  ])('reads a result header (%s)', (_id, raw, token, warns) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(resultToken(raw)).toBe(token)
    expect(warn.mock.calls.length > 0).toBe(warns)
  })
})
