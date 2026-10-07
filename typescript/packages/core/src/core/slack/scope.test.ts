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
import { detectScope, NATIVE_KINDS, searchTarget } from './scope.ts'

describe('detectScope', () => {
  it('classifies the root, which slack search answers workspace-wide', () => {
    expect(detectScope('/').kind).toBe(ROOT)
    expect(NATIVE_KINDS.has(ROOT)).toBe(true)
  })

  it('classifies the containers', () => {
    expect(detectScope('/channels').kind).toBe('channels_root')
    expect(detectScope('/dms').kind).toBe('dms_root')
    expect(detectScope('/users').kind).toBe('users_root')
  })

  it('classifies a channel dir and decodes both dirname halves', () => {
    const match = detectScope('/channels/general__C001')
    expect(match.kind).toBe('channel')
    expect(match.slots).toEqual({
      container: 'channels',
      channel: 'general',
      channel_id: 'C001',
    })
  })

  it('classifies a dm dir under the same kind', () => {
    const match = detectScope('/dms/alice__D001')
    expect(match.kind).toBe('channel')
    expect(match.slots.container).toBe('dms')
    expect(match.slots.channel_id).toBe('D001')
  })

  it('refuses a bare channel name', () => {
    // The tree mints every dirname as `name__id`, so a bare name can never
    // be a listed channel and classifies as invalid outright.
    expect(detectScope('/channels/general').kind).toBe(INVALID)
  })

  it('classifies a user file', () => {
    const match = detectScope('/users/alice__U001.json')
    expect(match.kind).toBe('user')
    expect(match.slots).toEqual({ user: 'alice', user_id: 'U001' })
    expect(NATIVE_KINDS.has('user')).toBe(false)
  })

  it('classifies a day directory', () => {
    const match = detectScope('/channels/general__C001/2024-04-10')
    expect(match.kind).toBe('day')
    expect(match.slots.day).toBe('2024-04-10')
    expect(NATIVE_KINDS.has('day')).toBe(false)
  })

  it('refuses a non-date under a channel', () => {
    expect(detectScope('/channels/general__C001/notadate').kind).toBe(INVALID)
  })

  it('classifies chat.jsonl, which the push-down never answers', () => {
    const match = detectScope('/channels/general__C001/2024-04-10/chat.jsonl')
    expect(match.kind).toBe('messages')
    expect(NATIVE_KINDS.has('messages')).toBe(false)
  })

  it('classifies the files dir, which search.files cannot day-filter', () => {
    expect(detectScope('/channels/general__C001/2024-04-10/files').kind).toBe('files')
    expect(NATIVE_KINDS.has('files')).toBe(false)
  })

  it('classifies a file blob', () => {
    const match = detectScope('/dms/bob__D001/2024-04-10/files/report__F1.pdf')
    expect(match.kind).toBe('file_blob')
    expect(match.slots.blob).toBe('report__F1.pdf')
    expect(NATIVE_KINDS.has('file_blob')).toBe(false)
  })

  it('refuses unknown roots', () => {
    expect(detectScope('/nope').kind).toBe(INVALID)
    expect(detectScope('/nope/deeper').kind).toBe(INVALID)
  })
})

describe('searchTarget', () => {
  it('carries the channel coordinates', () => {
    const target = searchTarget(detectScope('/channels/general__C001/2024-04-10'))
    expect(target).toEqual({
      container: 'channels',
      channelName: 'general',
      channelId: 'C001',
    })
  })

  it('carries only the container at a container root', () => {
    expect(searchTarget(detectScope('/dms'))).toEqual({ container: 'dms' })
  })

  it('is workspace-wide at the root', () => {
    expect(searchTarget(detectScope('/'))).toEqual({})
  })
})
