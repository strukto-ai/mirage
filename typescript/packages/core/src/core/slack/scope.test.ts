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
import { detectScope } from './scope.ts'
import { PathSpec } from '../../types.ts'

describe('detectScope', () => {
  it('root → useNative=true, resourcePath /', () => {
    const s = detectScope(new PathSpec({ original: '/', directory: '/' }))
    expect(s.useNative).toBe(true)
    expect(s.resourcePath).toBe('/')
  })

  it('/channels → container=channels, useNative=true', () => {
    const s = detectScope(new PathSpec({ original: '/channels', directory: '/channels' }))
    expect(s.useNative).toBe(true)
    expect(s.container).toBe('channels')
  })

  it('/channels/general__C123 → channelName=general, channelId=C123', () => {
    const s = detectScope(
      new PathSpec({
        original: '/channels/general__C123',
        directory: '/channels/general__C123',
      }),
    )
    expect(s.channelName).toBe('general')
    expect(s.channelId).toBe('C123')
    expect(s.container).toBe('channels')
    expect(s.useNative).toBe(true)
  })

  it('/channels/general__C123/2026-04-24 → date scope, useNative=true', () => {
    const s = detectScope(
      new PathSpec({
        original: '/channels/general__C123/2026-04-24',
        directory: '/channels/general__C123/2026-04-24',
      }),
    )
    expect(s.dateStr).toBe('2026-04-24')
    expect(s.target).toBe('date')
    expect(s.useNative).toBe(true)
  })

  it('/channels/<chan>/<date>/chat.jsonl → messages target, useNative=false', () => {
    const s = detectScope(
      new PathSpec({
        original: '/channels/general__C123/2026-04-24/chat.jsonl',
        directory: '/channels/general__C123/2026-04-24/chat.jsonl',
      }),
    )
    expect(s.dateStr).toBe('2026-04-24')
    expect(s.target).toBe('messages')
    expect(s.useNative).toBe(false)
  })

  it('/channels/<chan>/<date>/files → files target, useNative=true', () => {
    const s = detectScope(
      new PathSpec({
        original: '/channels/general__C123/2026-04-24/files',
        directory: '/channels/general__C123/2026-04-24/files',
      }),
    )
    expect(s.target).toBe('files')
    expect(s.useNative).toBe(true)
  })

  it('/channels/<chan>/<date>/files/<blob> → files target, useNative=false', () => {
    const s = detectScope(
      new PathSpec({
        original: '/channels/general__C123/2026-04-24/files/foo__F1.pdf',
        directory: '/channels/general__C123/2026-04-24/files/foo__F1.pdf',
      }),
    )
    expect(s.target).toBe('files')
    expect(s.useNative).toBe(false)
  })

  it('/users → useNative=false, resourcePath=users', () => {
    const s = detectScope(new PathSpec({ original: '/users', directory: '/users' }))
    expect(s.useNative).toBe(false)
    expect(s.resourcePath).toBe('users')
  })

  it('handles dirname without __id (just name)', () => {
    const s = detectScope(
      new PathSpec({
        original: '/channels/general',
        directory: '/channels/general',
      }),
    )
    expect(s.channelName).toBe('general')
    expect(s.channelId).toBeUndefined()
  })

  it('respects PathSpec.prefix', () => {
    const s = detectScope(
      new PathSpec({
        original: '/slack/channels/general__C1',
        directory: '/slack/channels/general__C1',
        prefix: '/slack',
      }),
    )
    expect(s.channelName).toBe('general')
    expect(s.channelId).toBe('C1')
  })
})
