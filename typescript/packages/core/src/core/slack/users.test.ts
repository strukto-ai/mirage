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
import { getUserProfile, listUsers, searchUsers } from './users.ts'
import { SlackAccessor } from '../../accessor/slack.ts'
import type { SlackResponse, SlackTransport } from './_client.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (call: number) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length))
  }
}

describe('listUsers', () => {
  it('calls users.list with limit=200 by default', async () => {
    const t = new FakeTransport(() => ({ ok: true, members: [] }))
    await listUsers(new SlackAccessor(t))
    expect(t.calls[0]?.endpoint).toBe('users.list')
    expect(t.calls[0]?.params).toMatchObject({ limit: '200' })
  })

  it('filters out deleted, bots, and USLACKBOT', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      members: [
        { id: 'U1', name: 'alice' },
        { id: 'U2', name: 'deleted-user', deleted: true },
        { id: 'U3', name: 'bot', is_bot: true },
        { id: 'USLACKBOT', name: 'slackbot' },
        { id: 'U4', name: 'bob' },
      ],
    }))
    const out = await listUsers(new SlackAccessor(t))
    expect(out.map((u) => (u as { id: string }).id)).toEqual(['U1', 'U4'])
  })

  it('returns empty when members missing', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await listUsers(new SlackAccessor(t))
    expect(out).toEqual([])
  })

  it('respects custom limit', async () => {
    const t = new FakeTransport(() => ({ ok: true, members: [] }))
    await listUsers(new SlackAccessor(t), { limit: 50 })
    expect(t.calls[0]?.params).toMatchObject({ limit: '50' })
  })

  it('paginates via response_metadata.next_cursor across pages', async () => {
    const t = new FakeTransport((call) => {
      if (call === 1) {
        return {
          ok: true,
          members: [{ id: 'U1', name: 'alice' }],
          response_metadata: { next_cursor: 'c2' },
        }
      }
      if (call === 2) {
        return {
          ok: true,
          members: [{ id: 'U2', name: 'bob' }],
          response_metadata: { next_cursor: '' },
        }
      }
      throw new Error('unexpected extra call')
    })
    const out = await listUsers(new SlackAccessor(t))
    expect(out.map((u) => (u as { id: string }).id)).toEqual(['U1', 'U2'])
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1]?.params?.cursor).toBe('c2')
  })

  it('stops paginating when next_cursor is empty / missing', async () => {
    let calls = 0
    const t = new FakeTransport(() => {
      calls++
      return { ok: true, members: [] }
    })
    await listUsers(new SlackAccessor(t))
    expect(calls).toBe(1)
  })
})

describe('getUserProfile', () => {
  it('calls users.info with the user id', async () => {
    const t = new FakeTransport(() => ({ ok: true, user: { id: 'U1', name: 'alice' } }))
    const out = await getUserProfile(new SlackAccessor(t), 'U1')
    expect(t.calls[0]?.endpoint).toBe('users.info')
    expect(t.calls[0]?.params).toMatchObject({ user: 'U1' })
    expect(out).toEqual({ id: 'U1', name: 'alice' })
  })

  it('returns empty object when user missing in response', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const out = await getUserProfile(new SlackAccessor(t), 'U1')
    expect(out).toEqual({})
  })
})

describe('searchUsers', () => {
  it('matches case-insensitive on name', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      members: [
        { id: 'U1', name: 'alice', real_name: 'Alice Cooper' },
        { id: 'U2', name: 'bob', real_name: 'Bob Dylan' },
      ],
    }))
    const out = await searchUsers(new SlackAccessor(t), 'ALI')
    expect(out.map((u) => (u as { id: string }).id)).toEqual(['U1'])
  })

  it('matches on real_name', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      members: [
        { id: 'U1', name: 'alice', real_name: 'Alice Cooper' },
        { id: 'U2', name: 'bob', real_name: 'Bob Dylan' },
      ],
    }))
    const out = await searchUsers(new SlackAccessor(t), 'dylan')
    expect(out.map((u) => (u as { id: string }).id)).toEqual(['U2'])
  })

  it('matches on profile.email', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      members: [{ id: 'U1', name: 'alice', profile: { email: 'alice@example.com' } }],
    }))
    const out = await searchUsers(new SlackAccessor(t), 'example.com')
    expect(out.map((u) => (u as { id: string }).id)).toEqual(['U1'])
  })

  it('respects deleted/bot/USLACKBOT filter (transitively via listUsers)', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      members: [
        { id: 'U1', name: 'alice' },
        { id: 'U2', name: 'alice-bot', is_bot: true },
      ],
    }))
    const out = await searchUsers(new SlackAccessor(t), 'alice')
    expect(out.map((u) => (u as { id: string }).id)).toEqual(['U1'])
  })
})
