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

import type { JsonValue } from '../../../types.ts'
import { field, textField } from '../../../events/index.ts'

/**
 * UTC day directory for a Slack timestamp, or null for one that names no day.
 *
 * Bucketing is UTC because `dateRange` in `readdir` is, so a 6pm PDT message
 * belongs to the *next* day's directory. Reading the consumer's local clock
 * here would name a directory the mount does not serve, and a notify on a path
 * that does not exist is silent.
 */
export function dayOf(ts: unknown): string | null {
  // `Number('')` and `Number(' ')` are 0, where python's `float` raises, so an
  // empty ts would silently bucket into 1970 rather than being skipped.
  if (ts === undefined || ts === null || (typeof ts === 'string' && ts.trim() === '')) return null
  const moment = new Date(Number(ts) * 1000)
  return Number.isNaN(moment.getTime()) ? null : moment.toISOString().slice(0, 10)
}

/**
 * Channel and ts a reaction or pin event points at.
 *
 * Both wrap the thing they happened to in an `item` rather than naming it at
 * the top level, and both spell the id `channel` inside it where `file_shared`
 * spells it `channel_id` outside.
 */
export function itemChannel(payload: JsonValue): [string | null, string | null] {
  const item = field(payload, 'item')
  return [textField(item, 'channel'), textField(item, 'ts')]
}

/**
 * The message object an event is about.
 *
 * An edit and a deletion both describe another message rather than themselves,
 * and nest it under a different key.
 */
export function subject(payload: JsonValue): JsonValue {
  const kind = textField(payload, 'subtype')
  if (kind === 'message_deleted') return field(payload, 'previous_message') ?? payload
  if (kind === 'message_changed') return field(payload, 'message') ?? payload
  return payload
}

/**
 * The ts of the message an event is about.
 *
 * Not always the event's own `ts`: an edit and a deletion both arrive stamped
 * now while naming a message from any earlier day, so taking the top-level ts
 * would refresh today's directory and leave the day that actually changed
 * stale.
 */
export function messageTs(payload: JsonValue): string | null {
  if (textField(payload, 'subtype') === 'message_deleted') {
    const deleted = textField(payload, 'deleted_ts')
    if (deleted !== null) return deleted
  }
  return textField(subject(payload), 'ts')
}

/** Whether a thread reply was also sent to the channel. */
export function isBroadcast(payload: JsonValue): boolean {
  const body = subject(payload)
  if (textField(body, 'subtype') === 'thread_broadcast') return true
  return field(body, 'reply_broadcast') === true
}

/**
 * Timestamps whose day directories a message event makes stale.
 *
 * Usually just the message's own, but a thread reply is the case that breaks
 * that: `chat.jsonl` renders `conversations.history`, which returns parents
 * only, so a reply is in no day file at all. What changed is the *parent's*
 * row, whose `reply_count` and `latest_reply` the same listing carries, in the
 * parent's day. A reply to a week-old thread therefore refreshes a week-old
 * directory and leaves today's alone.
 *
 * A broadcast reply is the exception to the exception: Slack puts it in the
 * channel history too, so both days change.
 */
export function affectedTs(payload: JsonValue): readonly string[] {
  const own = messageTs(payload)
  if (own === null) return []
  const thread = textField(subject(payload), 'thread_ts')
  if (thread === null || thread === own) return [own]
  return isBroadcast(payload) ? [thread, own] : [thread]
}

/**
 * The conversation id a listing event names.
 *
 * Slack spells it two ways for the same family: `channel_deleted` sends the
 * bare id, `channel_rename` sends the whole channel object.
 */
export function channelIdOf(payload: JsonValue): string | null {
  const direct = textField(payload, 'channel')
  if (direct !== null) return direct
  return textField(field(payload, 'channel'), 'id')
}
