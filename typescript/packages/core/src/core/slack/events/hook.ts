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

import type { SlackAccessor } from '../../../accessor/slack.ts'
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../../types.ts'
import { eventAt, textField } from '../../../events/index.ts'
import { channelDirname, dmDirname } from '../formatters.ts'
import {
  CHANNEL_LIST_EVENTS,
  CHAT_FILE,
  DM_LIST_EVENTS,
  FILES_DIR,
  ITEM_EVENTS,
  USER_LIST_EVENTS,
} from './constants.ts'
import { affectedTs, channelIdOf, dayOf, itemChannel } from './payload.ts'
import type { ConversationDir } from './types.ts'

/**
 * Map one Slack Events API delivery onto mount paths.
 *
 * The consumer runs the transport (an HTTP endpoint for the Events API or a
 * Socket Mode websocket), unwraps the `event_callback` envelope and passes the
 * inner event's `type` with its body.
 *
 * Every path this returns is rebuilt with the same functions `readdir` names
 * directories with, which is the reason this lives beside the backend rather
 * than in the consumer: a channel is `<name>__<C-id>` through `makeIdName`, a
 * DM is the *user's* name through `dmDirname`, and the day is bucketed in UTC.
 * Slack shows local time, so a consumer reimplementing the last rule would name
 * tomorrow's directory for a fifth of the day and never see an error, because a
 * notify on a path the mount does not serve evicts nothing.
 *
 * Resolution is the reason this holds state. An event names a channel by id
 * only, and the directory carries the name, so the id has to be resolved
 * through `conversations.info` (plus `users.info` for a DM, whose directory is
 * named after the other person). That is one or two API calls the first time a
 * conversation is seen and none after, against a Slack tier that allows roughly
 * 50 a minute; a stateless mapper would spend a call per message. A rename
 * drops the entry rather than patching it, since the whole subtree moved and
 * the answer is a re-inventory anyway.
 *
 * Three kinds of event map to something coarser than a file, and honestly so. A
 * listing change (a channel created, renamed or archived; a user's profile
 * edited) is UNKNOWN on the container directory, because the entry names
 * themselves changed. A shared file is UNKNOWN on that day's `files` directory,
 * because the rendered filename comes from `fileBlobName` over metadata the
 * notification does not carry, and the accompanying `message` event already
 * refreshes `chat.jsonl`.
 *
 * Two file events are unmapped, and neither is unmappable. A file blob is
 * addressed by the day it was *shared*, and neither event carries a
 * conversation or that day: `file_change` sends only `file_id`, `file_deleted`
 * sends `file_id` and the deletion's own `event_ts`. Asking Slack does not
 * recover it either, since `files.info` on a deleted file answers with the
 * `file_deleted` error. What does recover it is this mount's own index, which
 * stores each blob's Slack id as `IndexEntry.id`, so a reverse lookup names the
 * exact path; and a file the index has never seen is one nothing has cached, so
 * there is nothing to invalidate. The hook simply is not handed the index
 * today. Until it is, both ride the index TTL, which bounds the staleness
 * rather than removing it.
 *
 * `channel_shared` / `channel_unshared` are a third that looks like a gap and
 * is not: they change only the Slack Connect flags on the channel object, never
 * its `name` or `id`, which are the two things the directory is spelled from.
 *
 * Mirrors Python `SlackEventHook` (`core/slack/events/hook.py`).
 */
export class SlackEventHook {
  private readonly accessor: SlackAccessor
  private readonly dirs = new Map<string, ConversationDir>()
  private readonly users = new Map<string, string>()

  constructor(accessor: SlackAccessor) {
    this.accessor = accessor
  }

  /** Display name for a user id, memoized. */
  private async userName(userId: string): Promise<string> {
    const cached = this.users.get(userId)
    if (cached !== undefined) return cached
    const data = await this.accessor.transport.call('users.info', { user: userId })
    const user = (data.user ?? {}) as { name?: string }
    const name = user.name ?? userId
    this.users.set(userId, name)
    return name
  }

  /** Directory a conversation id maps to, memoized. */
  private async resolve(channelId: string): Promise<ConversationDir> {
    const cached = this.dirs.get(channelId)
    if (cached !== undefined) return cached
    const data = await this.accessor.transport.call('conversations.info', {
      channel: channelId,
    })
    const channel = (data.channel ?? {}) as {
      id?: string
      name?: string
      user?: string
      is_im?: boolean
      is_mpim?: boolean
    }
    const withId = { ...channel, id: channel.id ?? channelId }
    let resolved: ConversationDir
    if (withId.is_im === true || withId.is_mpim === true) {
      const userId = withId.user ?? ''
      const userMap = userId === '' ? {} : { [userId]: await this.userName(userId) }
      resolved = { container: 'dms', dirname: dmDirname(withId, userMap) }
    } else {
      resolved = { container: 'channels', dirname: channelDirname(withId) }
    }
    this.dirs.set(channelId, resolved)
    return resolved
  }

  /** Mount-relative day directory for a conversation and ts. */
  private async dayDir(channelId: string, ts: string): Promise<string | null> {
    const day = dayOf(ts)
    if (day === null) return null
    const where = await this.resolve(channelId)
    return `${where.container}/${where.dirname}/${day}`
  }

  /** One UPDATE per day directory the stamps land in. */
  private async transcripts(
    root: PathSpec,
    channelId: string | null,
    stamps: readonly string[],
  ): Promise<readonly FileEvent[]> {
    const out: FileEvent[] = []
    for (const ts of stamps) out.push(...(await this.transcript(root, channelId, ts)))
    return out
  }

  /** One UPDATE on the transcript a conversation and ts name. */
  private async transcript(
    root: PathSpec,
    channelId: string | null,
    ts: string | null,
  ): Promise<readonly FileEvent[]> {
    if (channelId === null || ts === null) return []
    const dayDir = await this.dayDir(channelId, ts)
    if (dayDir === null) return []
    return [eventAt(root, `${dayDir}/${CHAT_FILE}`, FileChangeKind.UPDATE)]
  }

  /** Map a shared file onto that day's attachment directory. */
  private async fileShared(root: PathSpec, payload: JsonValue): Promise<readonly FileEvent[]> {
    const channelId = textField(payload, 'channel_id')
    const ts = textField(payload, 'event_ts')
    if (channelId === null || ts === null) return []
    const dayDir = await this.dayDir(channelId, ts)
    if (dayDir === null) return []
    return [eventAt(root, `${dayDir}/${FILES_DIR}`, FileChangeKind.UNKNOWN)]
  }

  async toEvents(
    root: PathSpec,
    eventType: string,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    if (eventType === 'message') {
      return this.transcripts(root, textField(payload, 'channel'), affectedTs(payload))
    }
    if (ITEM_EVENTS.has(eventType)) {
      const [channelId, ts] = itemChannel(payload)
      return this.transcript(root, channelId, ts)
    }
    if (eventType === 'file_shared') return this.fileShared(root, payload)
    if (CHANNEL_LIST_EVENTS.has(eventType)) {
      const channelId = channelIdOf(payload)
      if (channelId !== null) this.dirs.delete(channelId)
      return [eventAt(root, 'channels', FileChangeKind.UNKNOWN)]
    }
    if (DM_LIST_EVENTS.has(eventType)) return [eventAt(root, 'dms', FileChangeKind.UNKNOWN)]
    if (USER_LIST_EVENTS.has(eventType)) return [eventAt(root, 'users', FileChangeKind.UNKNOWN)]
    return []
  }
}
