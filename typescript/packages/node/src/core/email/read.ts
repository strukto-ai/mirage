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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { resolveEntry } from '@struktoai/mirage-core/core/hierarchy/probe'
import { makeRead } from '@struktoai/mirage-core/core/hierarchy/read'
import type { ScopeMatch } from '@struktoai/mirage-core/core/hierarchy/scope'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { EmailAccessor } from '../../accessor/email.ts'
import { fetchAttachment, fetchMessage } from './client.ts'
import { readdir } from './readdir.ts'
import { messageJsonBytes } from './render.ts'
import { detectScope } from './scope.ts'

async function readMessage(
  accessor: EmailAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry === null) throw enoent(path)
  const msg = await fetchMessage(accessor, match.slots.folder ?? '', entry.id)
  return messageJsonBytes(msg)
}

async function readAttachment(
  accessor: EmailAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry === null) throw enoent(path)
  const data = await fetchAttachment(
    accessor,
    match.slots.folder ?? '',
    match.slots.uid ?? '',
    entry.vfsName,
  )
  if (data === null) throw enoent(path)
  return data
}

export const read = makeRead<EmailAccessor>(detectScope, {
  message: readMessage,
  attachment: readAttachment,
})
