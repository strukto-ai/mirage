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
import { channelDirname, dmDirname, fileBlobName, userFilename } from './formatters.ts'

describe('fileBlobName', () => {
  it.each([
    [{ id: 'F1', name: 'report.pdf', title: 'Q4' }, 'report__F1.pdf'],
    [{ id: 'F2', name: '', title: 'design doc.docx' }, 'design doc__F2.docx'],
    [{ id: 'F3' }, 'file__F3'],
  ])('names %j as %s', (meta, expected) => {
    expect(fileBlobName(meta)).toBe(expected)
  })
})

describe('dirname helpers', () => {
  it('channelDirname', () => {
    expect(channelDirname({ id: 'C1', name: 'general' })).toBe('general__C1')
  })

  it('channelDirname falls back to unknown when name missing', () => {
    expect(channelDirname({ id: 'C456' })).toBe('unknown__C456')
  })

  it('channelDirname preserves spaces and punctuation', () => {
    expect(channelDirname({ id: 'C789', name: 'eng team!' })).toBe('eng team!__C789')
  })

  it('dmDirname uses user_map', () => {
    expect(dmDirname({ id: 'D1', user: 'U1' }, { U1: 'alice' })).toBe('alice__D1')
  })

  it('dmDirname falls back to user id when not in map', () => {
    expect(dmDirname({ id: 'D2', user: 'U2' }, {})).toBe('U2__D2')
  })

  it('dmDirname handles empty user', () => {
    expect(dmDirname({ id: 'D3' }, {})).toBe('unknown__D3')
  })

  it('userFilename ends in .json', () => {
    expect(userFilename({ id: 'U1', name: 'alice' })).toBe('alice__U1.json')
  })

  it('userFilename falls back to unknown when name missing', () => {
    expect(userFilename({ id: 'U2' })).toBe('unknown__U2.json')
  })
})
