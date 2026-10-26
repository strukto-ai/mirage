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
import { serverLocation } from './location.ts'

describe('serverLocation', () => {
  it.each([
    ['redis://localhost:6379/0', 'redis://127.0.0.1:6379/0'],
    ['redis://localhost:6379/0', 'redis://[::1]:6379/0'],
    ['redis://localhost', 'redis://localhost:6379/0'],
    ['redis://localhost:6379', 'redis://localhost:6379/?db=0'],
    ['redis://localhost/2', 'redis://localhost/?db=2'],
    ['rediss://u:secret@LocalHost:6379/0', 'redis://localhost:6379/0'],
    ['unix:///tmp/a.sock', 'unix:///tmp/a.sock?db=0'],
  ])('matches %s and %s', (a, b) => {
    expect(serverLocation(a)).toBe(serverLocation(b))
  })

  it.each([
    ['redis://localhost:6379/0', 'redis://localhost:6379/1'],
    ['redis://localhost:6379/0', 'redis://localhost:6380/0'],
    ['redis://cache-a:6379/0', 'redis://cache-b:6379/0'],
    ['unix:///tmp/a.sock', 'unix:///tmp/b.sock'],
  ])('tells %s from %s', (a, b) => {
    expect(serverLocation(a)).not.toBe(serverLocation(b))
  })

  it('keeps the password out', () => {
    expect(serverLocation('redis://u:secret@cache:6379/0')).not.toContain('secret')
  })
})
