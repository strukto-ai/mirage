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

import type { PathSpec } from '../../types.ts'

export type SlackTarget = 'date' | 'messages' | 'files'

export interface SlackScope {
  useNative: boolean
  channelName?: string
  channelId?: string
  container?: string
  dateStr?: string
  target?: SlackTarget
  resourcePath: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '')
}

function splitDirname(dirname: string): [string, string | undefined] {
  const idx = dirname.lastIndexOf('__')
  if (idx === -1) {
    return [dirname, undefined]
  }
  const name = dirname.slice(0, idx)
  const cid = dirname.slice(idx + 2)
  return [name, cid.length > 0 ? cid : undefined]
}

function deepenedScope(
  parts: string[],
  prefix: string,
  channelName: string,
  cid: string | undefined,
  container: string,
  key: string,
  base: 'native' | 'non-native',
): SlackScope {
  const dateStr = parts[2] ?? ''
  const useNativeBase = base === 'native'
  if (parts.length === 2) {
    return {
      useNative: true,
      channelName,
      ...(cid !== undefined ? { channelId: cid } : {}),
      container,
      resourcePath: key,
    }
  }
  if (parts.length === 3 && DATE_RE.test(dateStr)) {
    return {
      useNative: useNativeBase,
      channelName,
      ...(cid !== undefined ? { channelId: cid } : {}),
      container,
      dateStr,
      target: 'date',
      resourcePath: key,
    }
  }
  if (parts.length === 4 && DATE_RE.test(dateStr) && parts[3] === 'chat.jsonl') {
    return {
      useNative: false,
      channelName,
      ...(cid !== undefined ? { channelId: cid } : {}),
      container,
      dateStr,
      target: 'messages',
      resourcePath: key,
    }
  }
  if (parts.length === 4 && DATE_RE.test(dateStr) && parts[3] === 'files') {
    return {
      useNative: true,
      channelName,
      ...(cid !== undefined ? { channelId: cid } : {}),
      container,
      dateStr,
      target: 'files',
      resourcePath: key,
    }
  }
  if (parts.length === 5 && DATE_RE.test(dateStr) && parts[3] === 'files') {
    return {
      useNative: false,
      channelName,
      ...(cid !== undefined ? { channelId: cid } : {}),
      container,
      dateStr,
      target: 'files',
      resourcePath: key,
    }
  }
  void prefix
  return { useNative: false, resourcePath: key }
}

export function detectScope(path: PathSpec): SlackScope {
  const prefix = path.prefix

  if (path.pattern !== null && path.pattern !== '') {
    let dirKey = stripSlashes(path.directory)
    if (prefix !== '') {
      const stripped = stripSlashes(prefix) + '/'
      if (dirKey.startsWith(stripped)) {
        dirKey = dirKey.slice(stripped.length)
      }
    }
    const dirParts = dirKey !== '' ? dirKey.split('/') : []
    const [dirRoot, dirEntry] = dirParts
    if (
      dirParts.length >= 2 &&
      dirEntry !== undefined &&
      (dirRoot === 'channels' || dirRoot === 'dms')
    ) {
      const [name, cid] = splitDirname(dirEntry)
      return deepenedScope(dirParts, prefix, name, cid, dirRoot, dirKey, 'native')
    }
  }

  const key = path.key
  if (key === '') {
    return { useNative: true, resourcePath: '/' }
  }

  const parts = key.split('/')
  const [root, second] = parts
  if (root === undefined) {
    return { useNative: false, resourcePath: key }
  }

  if (root === 'users') {
    return { useNative: false, resourcePath: key }
  }

  if (root !== 'channels' && root !== 'dms') {
    return { useNative: false, resourcePath: key }
  }

  if (parts.length === 1) {
    return { useNative: true, container: root, resourcePath: key }
  }

  if (second === undefined) {
    return { useNative: false, resourcePath: key }
  }

  const [name, cid] = splitDirname(second)
  return deepenedScope(parts, prefix, name, cid, root, key, 'native')
}
