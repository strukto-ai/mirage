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

import { INVALID, ROOT } from '../hierarchy/scope.ts'
import { detectScope, NATIVE_KINDS } from './scope.ts'

const CHAT = '/My Server__G1/channels/general__C1/2024-01-15/chat.jsonl'

describe('detectScope', () => {
  it('classifies the root', () => {
    expect(detectScope('/').kind).toBe(ROOT)
  })

  it('classifies a guild and decodes both dirname halves', () => {
    const match = detectScope('/My Server__G1')
    expect(match.kind).toBe('guild')
    expect(match.slots).toEqual({ guild: 'My Server', guild_id: 'G1' })
  })

  it('refuses a bare guild name', () => {
    // The tree mints every dirname as `name__id`, so a bare name can never
    // be a listed guild and classifies as invalid outright.
    expect(detectScope('/My Server').kind).toBe(INVALID)
  })

  it('classifies the containers', () => {
    expect(detectScope('/My Server__G1/channels').kind).toBe('channels_dir')
    expect(detectScope('/My Server__G1/members').kind).toBe('members_dir')
    expect(detectScope('/My Server__G1/nope').kind).toBe(INVALID)
  })

  it('classifies a channel', () => {
    const match = detectScope('/My Server__G1/channels/general__C1')
    expect(match.kind).toBe('channel')
    expect(match.slots.channel).toBe('general')
    expect(match.slots.channel_id).toBe('C1')
  })

  it('classifies a member profile', () => {
    const match = detectScope('/My Server__G1/members/alice__U1.json')
    expect(match.kind).toBe('member')
    expect(match.slots.member).toBe('alice')
    expect(match.slots.user_id).toBe('U1')
  })

  it('refuses a member without the .json suffix', () => {
    expect(detectScope('/My Server__G1/members/alice__U1').kind).toBe(INVALID)
  })

  it('classifies a day directory', () => {
    const match = detectScope('/My Server__G1/channels/general__C1/2024-01-15')
    expect(match.kind).toBe('day')
    expect(match.slots.day).toBe('2024-01-15')
  })

  it('refuses a non-date under a channel', () => {
    expect(detectScope('/My Server__G1/channels/general__C1/notadate').kind).toBe(INVALID)
  })

  it('classifies chat.jsonl as a leaf', () => {
    const match = detectScope(CHAT)
    expect(match.kind).toBe('messages')
    expect(match.scope?.leaf).toBe(true)
  })

  it('classifies the files dir and its blobs', () => {
    expect(detectScope('/My Server__G1/channels/general__C1/2024-01-15/files').kind).toBe('files')
    const blob = detectScope('/My Server__G1/channels/general__C1/2024-01-15/files/kept__A1.txt')
    expect(blob.kind).toBe('file_blob')
    expect(blob.slots.blob).toBe('kept__A1.txt')
  })

  it('refuses deep unknown paths and dot segments', () => {
    expect(detectScope('/My Server__G1/channels/general__C1/2024-01-15/files/a/b').kind).toBe(
      INVALID,
    )
    expect(detectScope('/My Server__G1/channels/.hidden__C1').kind).toBe(INVALID)
  })
})

describe('NATIVE_KINDS', () => {
  it('excludes the rendered leaves', () => {
    // A day and what it holds, member profiles and stored blobs are not
    // answerable by the guild message search, which takes no date; the
    // containers above them are.
    for (const kind of ['day', 'messages', 'files', 'member', 'file_blob']) {
      expect(NATIVE_KINDS.has(kind)).toBe(false)
    }
    for (const kind of ['guild', 'channels_dir', 'channel']) {
      expect(NATIVE_KINDS.has(kind)).toBe(true)
    }
  })
})
