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
import { DiscordAccessor } from '../../accessor/discord.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { listMembers, searchMembers } from './members.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(private readonly responder: () => DiscordResponse = () => null) {}
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    this.calls.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder())
  }
}

describe('listMembers', () => {
  it('GETs /guilds/<id>/members with default page size', async () => {
    const t = new FakeDiscordTransport(() => [{ user: { id: 'U1', username: 'alice' } }])
    const out = await listMembers(new DiscordAccessor(t), 'G1')
    expect(t.calls[0]?.method).toBe('GET')
    expect(t.calls[0]?.endpoint).toBe('/guilds/G1/members')
    expect(t.calls[0]?.params?.after).toBe('0')
    expect(t.calls[0]?.params?.limit).toBe(1000)
    expect(out).toEqual([{ user: { id: 'U1', username: 'alice' } }])
  })

  it('honors custom page size', async () => {
    const t = new FakeDiscordTransport(() => [])
    await listMembers(new DiscordAccessor(t), 'G1', 50)
    expect(t.calls[0]?.params?.limit).toBe(50)
  })

  it('returns empty array on non-array response', async () => {
    const t = new FakeDiscordTransport(() => null)
    const out = await listMembers(new DiscordAccessor(t), 'G1')
    expect(out).toEqual([])
  })
})

describe('searchMembers', () => {
  it('GETs /guilds/<id>/members/search with query and limit', async () => {
    const t = new FakeDiscordTransport(() => [{ user: { id: 'U1', username: 'alice' } }])
    const out = await searchMembers(new DiscordAccessor(t), 'G1', 'ali')
    expect(t.calls[0]?.method).toBe('GET')
    expect(t.calls[0]?.endpoint).toBe('/guilds/G1/members/search')
    expect(t.calls[0]?.params).toEqual({ query: 'ali', limit: 100 })
    expect(out).toEqual([{ user: { id: 'U1', username: 'alice' } }])
  })

  it('honors custom limit', async () => {
    const t = new FakeDiscordTransport(() => [])
    await searchMembers(new DiscordAccessor(t), 'G1', 'bob', 25)
    expect(t.calls[0]?.params).toEqual({ query: 'bob', limit: 25 })
  })

  it('returns empty array on non-array response', async () => {
    const t = new FakeDiscordTransport(() => null)
    const out = await searchMembers(new DiscordAccessor(t), 'G1', 'x')
    expect(out).toEqual([])
  })
})
