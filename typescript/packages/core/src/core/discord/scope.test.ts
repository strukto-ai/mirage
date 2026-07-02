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

import { stripSlash } from '../../utils/slash.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { detectScope } from './scope.ts'
import { PathSpec } from '../../types.ts'

describe('detectScope', () => {
  it('root → level=root, useNative=true, resourcePath /', () => {
    const s = detectScope(new PathSpec({ resourcePath: '', virtual: '/', directory: '/' }))
    expect(s.level).toBe('root')
    expect(s.useNative).toBe(true)
    expect(s.resourcePath).toBe('/')
  })

  it('/myserver__G1 → level=guild, guildName=myserver, guildId=G1, useNative=true', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1',
        virtual: '/myserver__G1',
        directory: '/myserver__G1',
      }),
    )
    expect(s.level).toBe('guild')
    expect(s.guildName).toBe('myserver')
    expect(s.guildId).toBe('G1')
    expect(s.useNative).toBe(true)
  })

  it('/myserver__G1/channels → level=guild, container=channels, guildId=G1, useNative=true', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/channels',
        virtual: '/myserver__G1/channels',
        directory: '/myserver__G1/channels',
      }),
    )
    expect(s.level).toBe('guild')
    expect(s.container).toBe('channels')
    expect(s.guildId).toBe('G1')
    expect(s.useNative).toBe(true)
  })

  it('/myserver__G1/members → level=guild, container=members, guildId=G1, useNative=false', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/members',
        virtual: '/myserver__G1/members',
        directory: '/myserver__G1/members',
      }),
    )
    expect(s.level).toBe('guild')
    expect(s.container).toBe('members')
    expect(s.guildId).toBe('G1')
    expect(s.useNative).toBe(false)
  })

  it('/myserver__G1/channels/general__C1 → level=channel, useNative=true', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/channels/general__C1',
        virtual: '/myserver__G1/channels/general__C1',
        directory: '/myserver__G1/channels/general__C1',
      }),
    )
    expect(s.level).toBe('channel')
    expect(s.guildName).toBe('myserver')
    expect(s.guildId).toBe('G1')
    expect(s.channelName).toBe('general')
    expect(s.channelId).toBe('C1')
    expect(s.container).toBe('channels')
    expect(s.useNative).toBe(true)
  })

  it('/myserver__G1/channels/general__C1/2026-04-24/chat.jsonl → level=messages', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/channels/general__C1/2026-04-24/chat.jsonl',
        virtual: '/myserver__G1/channels/general__C1/2026-04-24/chat.jsonl',
        directory: '/myserver__G1/channels/general__C1/2026-04-24/chat.jsonl',
      }),
    )
    expect(s.level).toBe('messages')
    expect(s.dateStr).toBe('2026-04-24')
    expect(s.useNative).toBe(false)
    expect(s.guildId).toBe('G1')
    expect(s.channelId).toBe('C1')
    expect(s.container).toBe('channels')
  })

  it('/myserver__G1/channels/general__C1/2026-04-24 → level=date', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/channels/general__C1/2026-04-24',
        virtual: '/myserver__G1/channels/general__C1/2026-04-24',
        directory: '/myserver__G1/channels/general__C1/2026-04-24',
      }),
    )
    expect(s.level).toBe('date')
    expect(s.dateStr).toBe('2026-04-24')
    expect(s.useNative).toBe(true)
  })

  it('/myserver__G1/channels/general__C1/2026-04-24/files/blob.png → level=file_blob', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: stripSlash(
          '/myserver__G1/channels/general__C1/2026-04-24/files/blob__A1.png',
        ),
        virtual: '/myserver__G1/channels/general__C1/2026-04-24/files/blob__A1.png',
        directory: '/myserver__G1/channels/general__C1/2026-04-24/files/blob__A1.png',
      }),
    )
    expect(s.level).toBe('file_blob')
    expect(s.dateStr).toBe('2026-04-24')
  })

  it('*.jsonl glob in channel dir → level=channel, useNative=true', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/channels/general__C1/*.jsonl',
        virtual: '/myserver__G1/channels/general__C1/*.jsonl',
        directory: '/myserver__G1/channels/general__C1',
        pattern: '*.jsonl',
      }),
    )
    expect(s.level).toBe('channel')
    expect(s.useNative).toBe(true)
    expect(s.guildId).toBe('G1')
    expect(s.channelId).toBe('C1')
    expect(s.container).toBe('channels')
  })

  it('handles dirname without __id (just name) gracefully', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/channels/general',
        virtual: '/myserver__G1/channels/general',
        directory: '/myserver__G1/channels/general',
      }),
    )
    expect(s.level).toBe('channel')
    expect(s.channelName).toBe('general')
    expect(s.channelId).toBeUndefined()
  })

  it('respects PathSpec.prefix', () => {
    const s = detectScope(
      new PathSpec({
        virtual: '/discord/myserver__G1/channels/general__C1',
        directory: '/discord/myserver__G1/channels/general__C1',
        resourcePath: mountKey('/discord/myserver__G1/channels/general__C1', '/discord'),
      }),
    )
    expect(s.level).toBe('channel')
    expect(s.guildName).toBe('myserver')
    expect(s.guildId).toBe('G1')
    expect(s.channelName).toBe('general')
    expect(s.channelId).toBe('C1')
  })

  it('respects PathSpec.prefix on glob inside channel dir', () => {
    const s = detectScope(
      new PathSpec({
        virtual: '/discord/myserver__G1/channels/general__C1/*.jsonl',
        directory: '/discord/myserver__G1/channels/general__C1',
        pattern: '*.jsonl',
        resourcePath: mountKey('/discord/myserver__G1/channels/general__C1/*.jsonl', '/discord'),
      }),
    )
    expect(s.level).toBe('channel')
    expect(s.useNative).toBe(true)
    expect(s.guildId).toBe('G1')
    expect(s.channelId).toBe('C1')
  })

  it('member json file → level=member, container=members, useNative=false', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver__G1/members/alice__U1.json',
        virtual: '/myserver__G1/members/alice__U1.json',
        directory: '/myserver__G1/members/alice__U1.json',
      }),
    )
    expect(s.level).toBe('member')
    expect(s.container).toBe('members')
    expect(s.useNative).toBe(false)
    expect(s.guildId).toBe('G1')
    expect(s.memberName).toBe('alice')
    expect(s.memberId).toBe('U1')
    expect(s.channelName).toBeUndefined()
    expect(s.channelId).toBeUndefined()
  })

  it('guild dirname without __id parsed gracefully', () => {
    const s = detectScope(
      new PathSpec({
        resourcePath: 'myserver',
        virtual: '/myserver',
        directory: '/myserver',
      }),
    )
    expect(s.level).toBe('guild')
    expect(s.guildName).toBe('myserver')
    expect(s.guildId).toBeUndefined()
  })
})
