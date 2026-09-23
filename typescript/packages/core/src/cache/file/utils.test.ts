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
import { globEscape, parseLimit, tokenOrNull } from './utils.ts'

describe('tokenOrNull', () => {
  // The `''` arm is the load-bearing one and the reason `??` cannot be
  // used at the call sites: `??` keeps an empty string, and the redis
  // store spells "no token" as `''` on the wire, so an entry holding it
  // would answer isFresh(key, '') with true.
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['etag-1', 'etag-1'],
  ])('folds %j to %j', (input, expected) => {
    expect(tokenOrNull(input)).toBe(expected)
  })
})

describe('parseLimit', () => {
  it.each([
    [1024, 1024],
    ['1024', 1024],
    ['1KB', 1024],
    ['2MB', 2 * 1024 * 1024],
    ['1GB', 1024 * 1024 * 1024],
  ])('parses %j as %i bytes', (input, expected) => {
    expect(parseLimit(input)).toBe(expected)
  })
})

describe('globEscape', () => {
  it('leaves an ordinary path alone', () => {
    expect(globEscape('/data/')).toBe('/data/')
  })

  it('neutralizes the metacharacters redis SCAN reads as wildcards', () => {
    // A mount prefix is a path, and a path may hold these characters.
    expect(globEscape('/da[1]*a?/')).toBe('/da\\[1\\]\\*a\\?/')
  })

  it('escapes the escape character', () => {
    expect(globEscape('a\\b')).toBe('a\\\\b')
  })
})
