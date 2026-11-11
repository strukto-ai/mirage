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
import { lstripSlash, rstripSlash, stripSlash } from './slash.ts'

const SAMPLES = ['', '/', '//', '///', 'a', '/a', 'a/', '/a/', '//a//', 'a/b/c', '/a/b/c/', 'a//b']

describe('slash helpers match Python str strip and the prior regex', () => {
  it('rstripSlash equals .replace(/\\/+$/, "")', () => {
    for (const s of SAMPLES) expect(rstripSlash(s)).toBe(s.replace(/\/+$/, ''))
  })

  it('lstripSlash equals .replace(/^\\/+/, "")', () => {
    for (const s of SAMPLES) expect(lstripSlash(s)).toBe(s.replace(/^\/+/, ''))
  })

  it('stripSlash equals .replace(/^\\/+|\\/+$/g, "")', () => {
    for (const s of SAMPLES) expect(stripSlash(s)).toBe(s.replace(/^\/+|\/+$/g, ''))
  })

  it('strips all repeated slashes like Python rstrip/lstrip/strip', () => {
    expect(rstripSlash('a///')).toBe('a')
    expect(lstripSlash('///a')).toBe('a')
    expect(stripSlash('///a///')).toBe('a')
    expect(stripSlash('///')).toBe('')
  })
})
