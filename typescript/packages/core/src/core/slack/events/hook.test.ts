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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FileChangeKind, PathSpec } from '../../../types.ts'
import { serve } from '../../../../tests/fixtures/kit_fake.ts'
import { INFO, SlackWorkspace } from '../../../../tests/core/slack/workspace.ts'
import { SlackEventHook } from './hook.ts'

// 2025-08-15T23:30:00Z is 4:30pm PDT the same day, so client and mount
// agree; 2025-08-16T05:00:00Z is 10pm PDT on the 15th, where they do not.
const TS = '1755300600.000100'
const LATE = '1755320400.000100'

const ROOT = new PathSpec({ virtual: '/s', directory: '/s', vfsPath: '' })

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

describe('SlackEventHook', () => {
  it("updates that day's transcript for a message", async () => {
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: TS })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C1/2025-08-15/chat.jsonl')
  })

  it('lands a late-evening message in the next UTC day', async () => {
    // The trap a consumer reimplementing this would fall into: Slack
    // shows 10pm PDT on the 15th, the mount serves the 16th.
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: LATE })
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C1/2025-08-16/chat.jsonl')
  })

  it('refreshes the day a deletion happened on', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'message', {
      channel: 'C1',
      subtype: 'message_deleted',
      ts: LATE,
      deleted_ts: TS,
    })
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C1/2025-08-15/chat.jsonl')
  })

  it('names a DM after the other person', async () => {
    // D1 is ana's DM, so its directory takes her name from users.info.
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'message', { channel: 'D1', ts: TS })
    expect(events[0]?.path.virtual).toBe('/s/dms/ana__D1/2025-08-15/chat.jsonl')
  })

  it('resolves a channel name once', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: TS })
    await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: LATE })
    expect(await workspace.count(INFO)).toBe(1)
  })

  it('updates the transcript a reaction annotates', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'reaction_added', {
      item: { channel: 'C1', ts: TS },
    })
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C1/2025-08-15/chat.jsonl')
  })

  it('updates the transcript for a pin', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'pin_added', { item: { channel: 'C1', ts: TS } })
    expect(events[0]?.kind).toBe(FileChangeKind.UPDATE)
  })

  it("re-inventories that day's attachments for a shared file", async () => {
    // The rendered name comes from fileBlobName over metadata the
    // notification does not carry, so the directory is the honest answer.
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'file_shared', {
      file_id: 'F1',
      channel_id: 'C1',
      event_ts: TS,
    })
    expect(events[0]?.kind).toBe(FileChangeKind.UNKNOWN)
    expect(events[0]?.path.virtual).toBe('/s/channels/general__C1/2025-08-15/files')
  })

  it('re-inventories channels on a listing change', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    for (const kind of ['channel_created', 'channel_archive', 'group_rename']) {
      const events = await hook.toEvents(ROOT, kind, { channel: { id: 'C1', name: 'new' } })
      expect(events[0]?.kind).toBe(FileChangeKind.UNKNOWN)
      expect(events[0]?.path.virtual).toBe('/s/channels')
    }
  })

  it('drops the memoized directory on a rename', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: TS })
    await hook.toEvents(ROOT, 'channel_rename', { channel: { id: 'C1', name: 'eng' } })
    await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: TS })
    expect(await workspace.count(INFO)).toBe(2)
  })

  it('reads a deleted channel id spelled as a bare string', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: TS })
    await hook.toEvents(ROOT, 'channel_deleted', { channel: 'C1' })
    await hook.toEvents(ROOT, 'message', { channel: 'C1', ts: TS })
    expect(await workspace.count(INFO)).toBe(2)
  })

  it('re-inventories dms on im_created', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    const events = await hook.toEvents(ROOT, 'im_created', { channel: { id: 'D1' } })
    expect(events[0]?.path.virtual).toBe('/s/dms')
  })

  it('re-inventories users on a profile change', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    for (const kind of ['user_change', 'team_join']) {
      const events = await hook.toEvents(ROOT, kind, { user: { id: 'U1' } })
      expect(events[0]?.kind).toBe(FileChangeKind.UNKNOWN)
      expect(events[0]?.path.virtual).toBe('/s/users')
    }
  })

  it('maps an unhandled event to nothing', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    expect(await hook.toEvents(ROOT, 'member_joined_channel', { channel: 'C1' })).toEqual([])
    expect(await workspace.run.requests()).toEqual([])
  })

  it('maps a message without a channel to nothing', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    expect(await hook.toEvents(ROOT, 'message', { ts: TS })).toEqual([])
    expect(await workspace.run.requests()).toEqual([])
  })

  it('maps a non-object payload to nothing', async () => {
    const hook = new SlackEventHook(workspace.accessor())
    expect(await hook.toEvents(ROOT, 'message', 'not-an-object')).toEqual([])
  })
})
