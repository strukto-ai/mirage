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
import { SlackAccessor } from '../../../accessor/slack.ts'
import { FileChangeKind, PathSpec } from '../../../types.ts'
import type { SlackResponse, SlackTransport } from '../client.ts'
import { SlackEventHook } from './hook.ts'

// 2025-08-15T23:30:00Z is 4:30pm PDT the same day, so client and mount
// agree; 2025-08-16T05:00:00Z is 10pm PDT on the 15th, where they do not.
const TS = '1755300600.000100'
const LATE = '1755320400.000100'

const ROOT = new PathSpec({ virtual: '/s', directory: '/s', vfsPath: '' })

interface Fake {
  hook: SlackEventHook
  calls: string[]
}

function fake(channel: Record<string, unknown>, user: Record<string, unknown> = {}): Fake {
  const calls: string[] = []
  const transport: SlackTransport = {
    call(endpoint: string): Promise<SlackResponse> {
      calls.push(endpoint)
      if (endpoint === 'conversations.info') return Promise.resolve({ ok: true, channel })
      return Promise.resolve({ ok: true, user })
    },
  }
  return { hook: new SlackEventHook(new SlackAccessor(transport)), calls }
}

describe('SlackEventHook', () => {
  it("updates that day's transcript for a message", async () => {
    const { hook } = fake({ id: 'C0288', name: 'general' })
    const events = await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: TS })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C0288/2025-08-15/chat.jsonl')
  })

  it('lands a late-evening message in the next UTC day', async () => {
    // The trap a consumer reimplementing this would fall into: Slack
    // shows 10pm PDT on the 15th, the mount serves the 16th.
    const { hook } = fake({ id: 'C0288', name: 'general' })
    const events = await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: LATE })
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C0288/2025-08-16/chat.jsonl')
  })

  it('refreshes the day a deletion happened on', async () => {
    const { hook } = fake({ id: 'C0288', name: 'general' })
    const events = await hook.toEvents(ROOT, 'message', {
      channel: 'C0288',
      subtype: 'message_deleted',
      ts: LATE,
      deleted_ts: TS,
    })
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C0288/2025-08-15/chat.jsonl')
  })

  it('names a DM after the other person', async () => {
    const { hook } = fake({ id: 'D0777', is_im: true, user: 'U0431' }, { name: 'ada' })
    const events = await hook.toEvents(ROOT, 'message', { channel: 'D0777', ts: TS })
    expect(events[0]?.path.virtual).toBe('/s/dms/ada__D0777/2025-08-15/chat.jsonl')
  })

  it('resolves a channel name once', async () => {
    const { hook, calls } = fake({ id: 'C0288', name: 'general' })
    await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: TS })
    await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: LATE })
    expect(calls).toEqual(['conversations.info'])
  })

  it('updates the transcript a reaction annotates', async () => {
    const { hook } = fake({ id: 'C0288', name: 'general' })
    const events = await hook.toEvents(ROOT, 'reaction_added', {
      item: { channel: 'C0288', ts: TS },
    })
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C0288/2025-08-15/chat.jsonl')
  })

  it('updates the transcript for a pin', async () => {
    const { hook } = fake({ id: 'C0288', name: 'general' })
    const events = await hook.toEvents(ROOT, 'pin_added', { item: { channel: 'C0288', ts: TS } })
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
  })

  it("re-inventories that day's attachments for a shared file", async () => {
    // The rendered name comes from fileBlobName over metadata the
    // notification does not carry, so the directory is the honest answer.
    const { hook } = fake({ id: 'C0288', name: 'general' })
    const events = await hook.toEvents(ROOT, 'file_shared', {
      file_id: 'F1',
      channel_id: 'C0288',
      event_ts: TS,
    })
    expect(events[0]?.kind).toBe(FileChangeKind.UNKNOWN)
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C0288/2025-08-15/files')
  })

  it('re-inventories channels on a listing change', async () => {
    const { hook } = fake({ id: 'C0288', name: 'general' })
    for (const kind of ['channel_created', 'channel_archive', 'group_rename']) {
      const events = await hook.toEvents(ROOT, kind, { channel: { id: 'C0288', name: 'new' } })
      expect(events[0]?.kind).toBe(FileChangeKind.UNKNOWN)
      expect(events[0]?.path.virtual).toBe('/s/channels')
    }
  })

  it('drops the memoized directory on a rename', async () => {
    const { hook, calls } = fake({ id: 'C0288', name: 'general' })
    await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: TS })
    await hook.toEvents(ROOT, 'channel_rename', { channel: { id: 'C0288', name: 'eng' } })
    await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: TS })
    expect(calls).toEqual(['conversations.info', 'conversations.info'])
  })

  it('reads a deleted channel id spelled as a bare string', async () => {
    const { hook, calls } = fake({ id: 'C0288', name: 'general' })
    await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: TS })
    await hook.toEvents(ROOT, 'channel_deleted', { channel: 'C0288' })
    await hook.toEvents(ROOT, 'message', { channel: 'C0288', ts: TS })
    expect(calls).toHaveLength(2)
  })

  it('re-inventories dms on im_created', async () => {
    const { hook } = fake({ id: 'D0777' })
    const events = await hook.toEvents(ROOT, 'im_created', { channel: { id: 'D0777' } })
    expect(events[0]?.path.virtual).toBe('/s/dms')
  })

  it('re-inventories users on a profile change', async () => {
    const { hook } = fake({ id: 'C0288' })
    for (const kind of ['user_change', 'team_join']) {
      const events = await hook.toEvents(ROOT, kind, { user: { id: 'U0431' } })
      expect(events[0]?.kind).toBe(FileChangeKind.UNKNOWN)
      expect(events[0]?.path.virtual).toBe('/s/users')
    }
  })

  it('maps an unhandled event to nothing', async () => {
    const { hook, calls } = fake({ id: 'C0288' })
    expect(await hook.toEvents(ROOT, 'member_joined_channel', { channel: 'C0288' })).toEqual([])
    expect(calls).toEqual([])
  })

  it('maps a message without a channel to nothing', async () => {
    const { hook, calls } = fake({ id: 'C0288' })
    expect(await hook.toEvents(ROOT, 'message', { ts: TS })).toEqual([])
    expect(calls).toEqual([])
  })

  it('maps a non-object payload to nothing', async () => {
    const { hook } = fake({ id: 'C0288' })
    expect(await hook.toEvents(ROOT, 'message', 'not-an-object')).toEqual([])
  })
})
