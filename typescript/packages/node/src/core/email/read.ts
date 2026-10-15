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

import { makeRead } from '@struktoai/mirage-core/core/hierarchy/read'
import type { ScopeMatch } from '@struktoai/mirage-core/core/hierarchy/scope'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import type { Handed } from '@struktoai/mirage-core/vfs/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchAttachment, fetchHeaders, fetchMessage } from './client.ts'
import { messageJsonBytes } from './render.ts'
import { detectScope } from './scope.ts'

async function readMessage(
  accessor: EmailAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<Uint8Array> {
  if (entry === null) throw enoent(path)
  const msg = await fetchMessage(accessor, match.slots.folder ?? '', String(entry.extra.uid))
  return messageJsonBytes(msg)
}

async function readAttachment(
  accessor: EmailAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<Uint8Array> {
  if (entry === null) throw enoent(path)
  const data = await fetchAttachment(
    accessor,
    match.slots.folder ?? '',
    match.slots.uid ?? '',
    entry.name,
  )
  if (data === null) throw enoent(path)
  return data
}

export const read = makeRead<EmailAccessor>(detectScope, {
  message: readMessage,
  attachment: readAttachment,
})

/**
 * Several message files, one UID FETCH per folder for all of them. A path
 * that is no message file, or one its folder's listing does not hold, is
 * left out for its own read to answer. Mirrors Python's `read_many`.
 */
export async function readMany(
  accessor: EmailAccessor,
  paths: readonly PathSpec[],
  limit: number,
  handed: readonly Handed[] = [],
): Promise<Map<string, Uint8Array>> {
  const folders = new Map<string, Map<string, string>>()
  for (const [i, path] of paths.entries()) {
    const match = detectScope(path)
    if (match.kind !== 'message') continue
    const entry = handed[i]?.entry ?? null
    if (entry === null || (entry.size ?? 0) > limit) continue
    const folder = match.slots.folder ?? ''
    const uids = folders.get(folder) ?? new Map<string, string>()
    uids.set(String(entry.extra.uid), path.virtual)
    folders.set(folder, uids)
  }
  const answers = new Map<string, Uint8Array>()
  for (const [folder, uids] of folders) {
    for (const msg of await fetchHeaders(accessor, folder, [...uids.keys()])) {
      const virtual = uids.get(msg.uid)
      const body = messageJsonBytes(msg)
      if (virtual !== undefined && body.byteLength <= limit) answers.set(virtual, body)
    }
  }
  return answers
}
