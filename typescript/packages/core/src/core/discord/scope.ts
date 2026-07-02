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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'

export type DiscordLevel =
  | 'root'
  | 'guild'
  | 'channel'
  | 'date'
  | 'messages'
  | 'files'
  | 'file_blob'
  | 'member'
  | 'file'

export interface DiscordScope {
  level: DiscordLevel
  useNative: boolean
  guildName?: string
  guildId?: string
  channelName?: string
  channelId?: string
  memberName?: string
  memberId?: string
  container?: 'channels' | 'members'
  dateStr?: string
  resourcePath: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function stripSlashes(s: string): string {
  return stripSlash(s)
}

function splitDirname(dirname: string): [string, string | undefined] {
  const idx = dirname.lastIndexOf('__')
  if (idx === -1) return [dirname, undefined]
  const name = dirname.slice(0, idx)
  const cid = dirname.slice(idx + 2)
  return [name, cid.length > 0 ? cid : undefined]
}

export function detectScope(path: PathSpec): DiscordScope {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)

  if (path.pattern?.endsWith('.jsonl')) {
    let dirKey = stripSlashes(path.directory)
    if (prefix) {
      const stripped = stripSlashes(prefix) + '/'
      if (dirKey.startsWith(stripped)) dirKey = dirKey.slice(stripped.length)
    }
    const dp = dirKey ? dirKey.split('/') : []
    if (dp.length === 3 && dp[1] === 'channels' && dp[0] && dp[2]) {
      const [guildName, guildId] = splitDirname(dp[0])
      const [channelName, channelId] = splitDirname(dp[2])
      return {
        level: 'channel',
        useNative: true,
        guildName,
        ...(guildId !== undefined ? { guildId } : {}),
        channelName,
        ...(channelId !== undefined ? { channelId } : {}),
        container: 'channels',
        resourcePath: dirKey,
      }
    }
    if (
      dp.length === 4 &&
      dp[1] === 'channels' &&
      dp[0] !== undefined &&
      dp[2] !== undefined &&
      dp[3] !== undefined &&
      DATE_RE.test(dp[3])
    ) {
      const [guildName, guildId] = splitDirname(dp[0])
      const [channelName, channelId] = splitDirname(dp[2])
      return {
        level: 'messages',
        useNative: true,
        guildName,
        ...(guildId !== undefined ? { guildId } : {}),
        channelName,
        ...(channelId !== undefined ? { channelId } : {}),
        container: 'channels',
        dateStr: dp[3],
        resourcePath: dirKey,
      }
    }
  }

  const key = path.resourcePath
  if (!key) return { level: 'root', useNative: true, resourcePath: '/' }

  const parts = key.split('/')
  const [first, second, third, fourth, fifth, sixth] = parts

  if (first === undefined) {
    return { level: 'guild', useNative: false, resourcePath: key }
  }

  if (parts.length === 1) {
    const [guildName, guildId] = splitDirname(first)
    return {
      level: 'guild',
      useNative: true,
      guildName,
      ...(guildId !== undefined ? { guildId } : {}),
      resourcePath: key,
    }
  }

  if (parts.length === 2 && second !== undefined) {
    const [guildName, guildId] = splitDirname(first)
    if (second === 'channels' || second === 'members') {
      return {
        level: 'guild',
        useNative: second === 'channels',
        guildName,
        ...(guildId !== undefined ? { guildId } : {}),
        container: second,
        resourcePath: key,
      }
    }
    return {
      level: 'guild',
      useNative: false,
      guildName,
      ...(guildId !== undefined ? { guildId } : {}),
      resourcePath: key,
    }
  }

  if (parts.length === 3 && second !== undefined && third !== undefined) {
    const [guildName, guildId] = splitDirname(first)
    if (second === 'channels') {
      const [channelName, channelId] = splitDirname(third)
      return {
        level: 'channel',
        useNative: true,
        guildName,
        ...(guildId !== undefined ? { guildId } : {}),
        channelName,
        ...(channelId !== undefined ? { channelId } : {}),
        container: 'channels',
        resourcePath: key,
      }
    }
    if (second === 'members') {
      const stem = third.endsWith('.json') ? third.slice(0, -5) : third
      const [memberName, memberId] = splitDirname(stem)
      return {
        level: 'member',
        useNative: false,
        guildName,
        ...(guildId !== undefined ? { guildId } : {}),
        memberName,
        ...(memberId !== undefined ? { memberId } : {}),
        container: 'members',
        resourcePath: key,
      }
    }
  }

  // /<guild>/channels/<ch>/<date>
  if (
    parts.length === 4 &&
    second === 'channels' &&
    third !== undefined &&
    fourth !== undefined &&
    DATE_RE.test(fourth)
  ) {
    const [guildName, guildId] = splitDirname(first)
    const [channelName, channelId] = splitDirname(third)
    return {
      level: 'date',
      useNative: true,
      guildName,
      ...(guildId !== undefined ? { guildId } : {}),
      channelName,
      ...(channelId !== undefined ? { channelId } : {}),
      container: 'channels',
      dateStr: fourth,
      resourcePath: key,
    }
  }

  // /<guild>/channels/<ch>/<date>/chat.jsonl or /<date>/files
  if (
    parts.length === 5 &&
    second === 'channels' &&
    third !== undefined &&
    fourth !== undefined &&
    DATE_RE.test(fourth)
  ) {
    const [guildName, guildId] = splitDirname(first)
    const [channelName, channelId] = splitDirname(third)
    if (fifth === 'chat.jsonl') {
      return {
        level: 'messages',
        useNative: false,
        guildName,
        ...(guildId !== undefined ? { guildId } : {}),
        channelName,
        ...(channelId !== undefined ? { channelId } : {}),
        container: 'channels',
        dateStr: fourth,
        resourcePath: key,
      }
    }
    if (fifth === 'files') {
      return {
        level: 'files',
        useNative: true,
        guildName,
        ...(guildId !== undefined ? { guildId } : {}),
        channelName,
        ...(channelId !== undefined ? { channelId } : {}),
        container: 'channels',
        dateStr: fourth,
        resourcePath: key,
      }
    }
  }

  // /<guild>/channels/<ch>/<date>/files/<blob>
  if (
    parts.length === 6 &&
    second === 'channels' &&
    third !== undefined &&
    fourth !== undefined &&
    DATE_RE.test(fourth) &&
    fifth === 'files' &&
    sixth !== undefined
  ) {
    const [guildName, guildId] = splitDirname(first)
    const [channelName, channelId] = splitDirname(third)
    return {
      level: 'file_blob',
      useNative: false,
      guildName,
      ...(guildId !== undefined ? { guildId } : {}),
      channelName,
      ...(channelId !== undefined ? { channelId } : {}),
      container: 'channels',
      dateStr: fourth,
      resourcePath: key,
    }
  }

  return { level: 'guild', useNative: false, resourcePath: key }
}
