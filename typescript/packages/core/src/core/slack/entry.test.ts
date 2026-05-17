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
import { channelDirname, dmDirname, sanitizeName, userFilename } from './entry.ts'

describe('sanitizeName', () => {
  it('returns "unknown" for empty/whitespace input', () => {
    expect(sanitizeName('')).toBe('unknown')
    expect(sanitizeName('   ')).toBe('unknown')
  })

  it('replaces unsafe chars with underscore', () => {
    expect(sanitizeName("alice's-channel")).toBe('alice_s-channel')
    expect(sanitizeName('hello#world')).toBe('hello_world')
  })

  it('replaces spaces with underscore', () => {
    expect(sanitizeName('hello world')).toBe('hello_world')
  })

  it('collapses multiple underscores', () => {
    expect(sanitizeName("a''b")).toBe('a_b')
  })

  it('strips leading/trailing underscores', () => {
    expect(sanitizeName('__hello__')).toBe('hello')
  })

  it('truncates to 100 chars', () => {
    const long = 'x'.repeat(150)
    expect(sanitizeName(long)).toBe('x'.repeat(100))
  })

  it('preserves dots and hyphens', () => {
    expect(sanitizeName('foo.bar-baz')).toBe('foo.bar-baz')
  })
})

describe('channelDirname', () => {
  it('returns name__id', () => {
    expect(channelDirname({ id: 'C123', name: 'general' })).toBe('general__C123')
  })

  it('falls back to unknown when name missing', () => {
    expect(channelDirname({ id: 'C456' })).toBe('unknown__C456')
  })

  it('preserves spaces and punctuation', () => {
    expect(channelDirname({ id: 'C789', name: 'eng team!' })).toBe('eng team!__C789')
  })
})

describe('dmDirname', () => {
  it('looks up user name from map', () => {
    expect(dmDirname({ id: 'D1', user: 'U1' }, { U1: 'alice' })).toBe('alice__D1')
  })

  it('falls back to user id when not in map', () => {
    expect(dmDirname({ id: 'D2', user: 'U2' }, {})).toBe('U2__D2')
  })

  it('handles empty user', () => {
    expect(dmDirname({ id: 'D3' }, {})).toBe('unknown__D3')
  })
})

describe('userFilename', () => {
  it('returns name__id.json', () => {
    expect(userFilename({ id: 'U1', name: 'alice' })).toBe('alice__U1.json')
  })

  it('falls back to unknown when name missing', () => {
    expect(userFilename({ id: 'U2' })).toBe('unknown__U2.json')
  })

  it('preserves spaces and punctuation', () => {
    expect(userFilename({ id: 'U3', name: 'bob jones' })).toBe('bob jones__U3.json')
  })
})
