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

import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { getAttachment, getMessageRaw, messageJsonBytes } from './messages.ts'
import { detectScope } from './scope.ts'

async function readMessage(
  accessor: GmailAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<Uint8Array> {
  if (entry === null) throw enoent(path)
  const raw = await getMessageRaw(accessor.tokenManager, String(entry.extra.message_id))
  return messageJsonBytes(raw)
}

async function readAttachment(
  accessor: GmailAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<Uint8Array> {
  // The message id decodes from the attachment dir's `subject__id`
  // segment; the attachment id only exists in the listing, so the row
  // stays the proof of existence AND the id source.
  if (entry === null) throw enoent(path)
  return getAttachment(
    accessor.tokenManager,
    match.slots.message_id ?? '',
    String(entry.extra.attachment_id),
  )
}

export const read = makeRead<GmailAccessor>(detectScope, {
  message: readMessage,
  attachment: readAttachment,
})
