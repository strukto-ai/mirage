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
import { ContentType, FileType } from '../../types.ts'
import { compactJsonBytes } from '../render/json.ts'
import {
  channelDirname,
  channelEntry,
  guildDirname,
  guildEntry,
  historyEntry,
  memberEntry,
  memberFilename,
} from './entry.ts'

describe('guildDirname', () => {
  it('returns name__id with original spelling preserved', () => {
    expect(guildDirname({ id: 'G1', name: 'My Server' })).toBe('My Server__G1')
  })

  it('falls back to unknown when name missing', () => {
    expect(guildDirname({ id: 'G1' })).toBe('unknown__G1')
  })

  it('preserves special characters except the path separator', () => {
    expect(guildDirname({ id: 'G2', name: 'cool!server' })).toBe('cool!server__G2')
    expect(guildDirname({ id: 'G3', name: 'A/B Test' })).toBe('A∕B Test__G3')
  })
})

describe('channelDirname', () => {
  it('returns name__id', () => {
    expect(channelDirname({ id: 'C123', name: 'general' })).toBe('general__C123')
  })

  it('falls back to unknown when name missing', () => {
    expect(channelDirname({ id: 'C456' })).toBe('unknown__C456')
  })

  it('preserves spaces and unicode', () => {
    expect(channelDirname({ id: 'C789', name: 'eng team!' })).toBe('eng team!__C789')
    expect(channelDirname({ id: 'C790', name: '🔥-deals' })).toBe('🔥-deals__C790')
  })
})

describe('memberFilename', () => {
  it('returns name__id.json', () => {
    expect(memberFilename({ id: 'M1', name: 'alice' })).toBe('alice__M1.json')
  })

  it('falls back to unknown when name missing', () => {
    expect(memberFilename({ id: 'M2' })).toBe('unknown__M2.json')
  })

  it('preserves special characters', () => {
    expect(memberFilename({ id: 'M3', name: 'bob jones' })).toBe('bob jones__M3.json')
  })
})

describe('discord rows', () => {
  it('guildEntry() names the guild dir and carries its id', () => {
    const row = guildEntry({ id: 'G1', name: 'My Server' })
    expect(row.name).toBe('My Server__G1')
    expect(row.type).toBe(FileType.DIRECTORY)
    expect(row.extra).toEqual({ guild_id: 'G1' })
  })

  it('guildEntry() handles missing name', () => {
    expect(guildEntry({ id: 'G2' }).name).toBe('unknown__G2')
  })

  it('channelEntry() carries its id and newest message', () => {
    const row = channelEntry({ id: '1', name: 'general', last_message_id: '4194304' })
    expect(row.name).toBe('general__1')
    expect(row.type).toBe(FileType.DIRECTORY)
    expect(row.modified).toBe('2015-01-01T00:00:00Z')
    expect(row.extra).toEqual({ channel_id: '1', last_message_id: '4194304' })
  })

  it('channelEntry() handles missing name and no message', () => {
    const row = channelEntry({ id: 'C2' })
    expect(row.name).toBe('unknown__C2')
    expect(row.modified).toBeNull()
    expect(row.extra).toEqual({ channel_id: 'C2', last_message_id: '' })
  })

  it('memberEntry() is the rendered member file', () => {
    const member = { user: { id: 'M1', username: 'alice' } }
    const row = memberEntry(member)
    expect(row.name).toBe('alice__M1.json')
    expect(row.type).toBe(FileType.FILE)
    expect(row.content).toBe(ContentType.JSON)
    expect(row.size).toBe(compactJsonBytes(member).byteLength)
    expect(row.extra).toEqual({ user_id: 'M1' })
  })

  it('memberEntry() handles missing name', () => {
    expect(memberEntry({ user: { id: 'M2' } }).name).toBe('unknown__M2.json')
  })

  it('historyEntry() is a day dir carrying its channel', () => {
    const row = historyEntry('C1', '2026-04-25')
    expect(row.name).toBe('2026-04-25')
    expect(row.type).toBe(FileType.DIRECTORY)
    expect(row.extra).toEqual({ channel_id: 'C1' })
  })
})
