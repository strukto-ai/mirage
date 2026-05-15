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

import { IndexEntry } from '../../cache/index/config.ts'

export const SlackResourceType = Object.freeze({
  CHANNEL: 'slack/channel',
  DM: 'slack/dm',
  USER: 'slack/user',
  DATE_DIR: 'slack/date_dir',
  CHAT_JSONL: 'slack/chat_jsonl',
  FILES_DIR: 'slack/files_dir',
  FILE: 'slack/file',
} as const)

export type SlackResourceType = (typeof SlackResourceType)[keyof typeof SlackResourceType]

const UNSAFE_CHARS = /[^\w\s\-.]/g
const MULTI_UNDERSCORE = /_+/g
const MAX_LEN = 100

export function sanitizeName(name: string): string {
  if (name.trim() === '') return 'unknown'
  let cleaned = name.replace(UNSAFE_CHARS, '_')
  cleaned = cleaned.replace(/ /g, '_')
  cleaned = cleaned.replace(MULTI_UNDERSCORE, '_')
  cleaned = cleaned.replace(/^_+|_+$/g, '')
  if (cleaned.length > MAX_LEN) cleaned = cleaned.slice(0, MAX_LEN)
  return cleaned
}

function makeIdName(name: string, id: string): string {
  return `${sanitizeName(name)}__${id}`
}

export function channelDirname(ch: { id: string; name?: string }): string {
  return makeIdName(ch.name ?? ch.id, ch.id)
}

export function dmDirname(
  dm: { id: string; user?: string },
  userMap: Record<string, string>,
): string {
  const uid = dm.user ?? ''
  const display = userMap[uid] ?? (uid === '' ? '' : uid)
  return makeIdName(display, dm.id)
}

export function userFilename(u: { id: string; name?: string }): string {
  return `${sanitizeName(u.name ?? u.id)}__${u.id}.json`
}

export function fileBlobName(file: { id?: string; name?: string; title?: string }): string {
  const raw = file.name ?? file.title ?? 'file'
  const fid = file.id ?? ''
  const dot = raw.lastIndexOf('.')
  if (dot >= 0) {
    const stem = raw.slice(0, dot)
    const ext = raw.slice(dot + 1)
    return `${sanitizeName(stem)}__${fid}.${ext}`
  }
  return `${sanitizeName(raw)}__${fid}`
}

interface SlackFileMeta {
  id: string
  name?: string
  title?: string
  size?: number
  mimetype?: string
  filetype?: string
  url_private_download?: string
  timestamp?: number | string
}

export const SlackIndexEntry = {
  channel(ch: { id: string; name?: string; created?: number }): IndexEntry {
    return new IndexEntry({
      id: ch.id,
      name: ch.name ?? '',
      resourceType: SlackResourceType.CHANNEL,
      vfsName: makeIdName(ch.name ?? ch.id, ch.id),
      remoteTime: String(ch.created ?? 0),
    })
  },

  dm(
    dm: { id: string; user?: string; created?: number },
    userMap: Record<string, string>,
  ): IndexEntry {
    const uid = dm.user ?? ''
    const display = userMap[uid] ?? uid
    return new IndexEntry({
      id: dm.id,
      name: display,
      resourceType: SlackResourceType.DM,
      vfsName: makeIdName(display, dm.id),
      remoteTime: String(dm.created ?? 0),
    })
  },

  user(u: { id: string; name?: string }): IndexEntry {
    return new IndexEntry({
      id: u.id,
      name: u.name ?? '',
      resourceType: SlackResourceType.USER,
      vfsName: userFilename(u),
    })
  },

  dateDir(channelId: string, date: string): IndexEntry {
    return new IndexEntry({
      id: `${channelId}:${date}`,
      name: date,
      resourceType: SlackResourceType.DATE_DIR,
      vfsName: date,
    })
  },

  chatJsonl(channelId: string, date: string): IndexEntry {
    return new IndexEntry({
      id: `${channelId}:${date}:chat`,
      name: 'chat.jsonl',
      resourceType: SlackResourceType.CHAT_JSONL,
      vfsName: 'chat.jsonl',
    })
  },

  filesDir(channelId: string, date: string): IndexEntry {
    return new IndexEntry({
      id: `${channelId}:${date}:files`,
      name: 'files',
      resourceType: SlackResourceType.FILES_DIR,
      vfsName: 'files',
    })
  },

  file(file: SlackFileMeta, channelId: string, date: string, messageTs: string): IndexEntry {
    const blob = fileBlobName({
      id: file.id,
      ...(file.name !== undefined ? { name: file.name } : {}),
      ...(file.title !== undefined ? { title: file.title } : {}),
    })
    return new IndexEntry({
      id: file.id,
      name: file.title ?? file.name ?? '',
      resourceType: SlackResourceType.FILE,
      vfsName: blob,
      size: file.size ?? null,
      remoteTime: String(file.timestamp ?? ''),
      extra: {
        mimetype: file.mimetype ?? '',
        url_private_download: file.url_private_download ?? '',
        filetype: file.filetype ?? '',
        ts: messageTs,
        channel_id: channelId,
        date,
      },
    })
  },
}
