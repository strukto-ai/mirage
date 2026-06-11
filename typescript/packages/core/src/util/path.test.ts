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
import { basename, norm, parent } from './path.ts'

describe('norm', () => {
  it('adds a leading slash', () => {
    expect(norm('a/b.txt')).toBe('/a/b.txt')
  })
  it('strips a trailing slash', () => {
    expect(norm('/a/b/')).toBe('/a/b')
  })
  it('collapses empty and root to /', () => {
    expect(norm('')).toBe('/')
    expect(norm('/')).toBe('/')
  })
})

describe('parent', () => {
  it('returns the parent of a nested path', () => {
    expect(parent('/a/b/c.txt')).toBe('/a/b')
  })
  it('returns / for a top-level path', () => {
    expect(parent('/a.txt')).toBe('/')
  })
  it('returns / for root', () => {
    expect(parent('/')).toBe('/')
  })
})

describe('basename', () => {
  it('returns the last segment', () => {
    expect(basename('/a/b/c.txt')).toBe('c.txt')
  })
  it('returns / for root', () => {
    expect(basename('/')).toBe('/')
  })
})
