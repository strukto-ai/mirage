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

import { pathSafeName } from './entry.ts'

export interface DiscordAttachment {
  id: string
  filename?: string
  title?: string
  url?: string
  proxy_url?: string
  content_type?: string
  size?: number
}

export function fileBlobName(att: DiscordAttachment): string {
  const rawName = att.filename ?? att.title ?? 'file'
  const aid = att.id
  const dot = rawName.lastIndexOf('.')
  if (dot >= 0 && dot < rawName.length - 1) {
    const stem = rawName.slice(0, dot)
    const ext = rawName.slice(dot + 1)
    return `${pathSafeName(stem)}__${aid}.${ext}`
  }
  return `${pathSafeName(rawName)}__${aid}`
}

export async function downloadFile(url: string): Promise<Uint8Array> {
  const resp = await globalThis.fetch(url, { method: 'GET' })
  if (!resp.ok) {
    throw new Error(`discord download_file failed: ${String(resp.status)} ${resp.statusText}`)
  }
  return new Uint8Array(await resp.arrayBuffer())
}
