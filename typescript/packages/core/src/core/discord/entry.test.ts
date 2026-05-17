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
import {
  channelDirname,
  DiscordIndexEntry,
  DiscordResourceType,
  guildDirname,
  memberFilename,
  sanitizeName,
} from './entry.ts'

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

describe('DiscordIndexEntry', () => {
  it('guild() returns IndexEntry with discord/guild resourceType', () => {
    const entry = DiscordIndexEntry.guild({ id: 'G1', name: 'My Server' })
    expect(entry.id).toBe('G1')
    expect(entry.name).toBe('My Server')
    expect(entry.resourceType).toBe(DiscordResourceType.GUILD)
    expect(entry.resourceType).toBe('discord/guild')
    expect(entry.vfsName).toBe('My Server__G1')
  })

  it('guild() handles missing name', () => {
    const entry = DiscordIndexEntry.guild({ id: 'G2' })
    expect(entry.name).toBe('')
    expect(entry.vfsName).toBe('unknown__G2')
  })

  it('channel() returns IndexEntry with discord/channel resourceType', () => {
    const entry = DiscordIndexEntry.channel({ id: 'C1', name: 'general' })
    expect(entry.id).toBe('C1')
    expect(entry.name).toBe('general')
    expect(entry.resourceType).toBe(DiscordResourceType.CHANNEL)
    expect(entry.resourceType).toBe('discord/channel')
    expect(entry.vfsName).toBe('general__C1')
  })

  it('channel() handles missing name', () => {
    const entry = DiscordIndexEntry.channel({ id: 'C2' })
    expect(entry.name).toBe('')
    expect(entry.vfsName).toBe('unknown__C2')
  })

  it('member() returns IndexEntry with discord/member resourceType', () => {
    const entry = DiscordIndexEntry.member({ id: 'M1', name: 'alice' })
    expect(entry.id).toBe('M1')
    expect(entry.name).toBe('alice')
    expect(entry.resourceType).toBe(DiscordResourceType.MEMBER)
    expect(entry.resourceType).toBe('discord/member')
    expect(entry.vfsName).toBe('alice__M1.json')
  })

  it('member() handles missing name', () => {
    const entry = DiscordIndexEntry.member({ id: 'M2' })
    expect(entry.name).toBe('')
    expect(entry.vfsName).toBe('unknown__M2.json')
  })

  it('history() returns IndexEntry with discord/history resourceType', () => {
    const entry = DiscordIndexEntry.history('C1', '2026-04-25')
    expect(entry.id).toBe('C1:2026-04-25')
    expect(entry.name).toBe('2026-04-25')
    expect(entry.resourceType).toBe(DiscordResourceType.HISTORY)
    expect(entry.resourceType).toBe('discord/history')
    expect(entry.vfsName).toBe('2026-04-25.jsonl')
  })
})

describe('DiscordResourceType', () => {
  it('exposes the four entity types', () => {
    expect(DiscordResourceType.GUILD).toBe('discord/guild')
    expect(DiscordResourceType.CHANNEL).toBe('discord/channel')
    expect(DiscordResourceType.MEMBER).toBe('discord/member')
    expect(DiscordResourceType.HISTORY).toBe('discord/history')
  })
})
