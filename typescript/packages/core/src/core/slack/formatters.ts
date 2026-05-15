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

import { channelDirname, dmDirname, fileBlobName, sanitizeName, userFilename } from './entry.ts'
import type { SlackScope } from './scope.ts'

const DEC = new TextDecoder('utf-8', { fatal: false })

interface SearchMessageMatch {
  channel?: { name?: string; id?: string }
  ts?: string
  username?: string
  user?: string
  text?: string
}

interface SearchMessagePayload {
  messages?: { matches?: SearchMessageMatch[] }
}

interface SearchFileMatch {
  id?: string
  name?: string
  title?: string
  timestamp?: number | string
}

interface SearchFilesPayload {
  files?: { matches?: SearchFileMatch[] }
}

export function buildQuery(pattern: string, scope: SlackScope): string {
  if (
    scope.container === 'channels' &&
    scope.channelName !== undefined &&
    scope.channelName !== ''
  ) {
    return `in:#${scope.channelName} ${pattern}`
  }
  if (scope.container === 'dms' && scope.channelName !== undefined && scope.channelName !== '') {
    return `in:@${scope.channelName} ${pattern}`
  }
  return pattern
}

function tsToDate(ts: string | number | undefined): string {
  if (ts === undefined) return ''
  const tsFloat = typeof ts === 'number' ? ts : Number.parseFloat(ts)
  if (!Number.isFinite(tsFloat)) return ''
  return new Date(tsFloat * 1000).toISOString().slice(0, 10)
}

export function formatGrepResults(raw: Uint8Array, scope: SlackScope, prefix: string): string[] {
  const payload = JSON.parse(DEC.decode(raw)) as SearchMessagePayload
  const matches = payload.messages?.matches ?? []
  const lines: string[] = []
  for (const msg of matches) {
    const ch = msg.channel ?? {}
    const chName = ch.name ?? scope.channelName ?? ''
    const chId = ch.id ?? scope.channelId ?? ''
    const container = scope.container ?? 'channels'
    const dateStr = tsToDate(msg.ts ?? '0')
    const dirname = chId !== '' ? `${sanitizeName(chName)}__${chId}` : sanitizeName(chName)
    const path =
      dateStr !== ''
        ? `${prefix}/${container}/${dirname}/${dateStr}/chat.jsonl`
        : `${prefix}/${container}/${dirname}`
    const author = msg.username ?? msg.user ?? '?'
    const text = (msg.text ?? '').replaceAll('\n', ' ')
    lines.push(`${path}:[${author}] ${text}`)
  }
  return lines
}

export function formatFileGrepResults(
  raw: Uint8Array,
  scope: SlackScope,
  prefix: string,
): string[] {
  const payload = JSON.parse(DEC.decode(raw)) as SearchFilesPayload
  const matches = payload.files?.matches ?? []
  const lines: string[] = []
  for (const f of matches) {
    const fid = f.id ?? ''
    const title = f.title ?? f.name ?? fid
    const blob = fileBlobName(f)
    const dateStr = tsToDate(f.timestamp)
    if (scope.channelId === undefined || scope.channelId === '') continue
    const chId = scope.channelId
    const chName = scope.channelName ?? ''
    const safeName = chName !== '' ? sanitizeName(chName) : ''
    const dirname = safeName !== '' ? `${safeName}__${chId}` : chId
    const container = scope.container ?? 'channels'
    const path =
      dateStr !== ''
        ? `${prefix}/${container}/${dirname}/${dateStr}/files/${blob}`
        : `${prefix}/${container}/${dirname}/files/${blob}`
    lines.push(`${path}:[file] ${title}`)
  }
  return lines
}

export { channelDirname, dmDirname, fileBlobName, userFilename }
