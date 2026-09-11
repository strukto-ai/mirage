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

import { Codec, DATE } from '@struktoai/mirage-core/core/hierarchy/codec'
import { makeDetectScope, Scope, Slot } from '@struktoai/mirage-core/core/hierarchy/scope'
import { ContentType } from '@struktoai/mirage-core/types'

const EMAIL_JSON = new Codec({ suffix: '.email.json' })

const FOLDER = [new Slot('folder')] as const
const DAY = [...FOLDER, new Slot('day', DATE)] as const

// One description of the tree: readdir, stat, read and the search push-down
// all classify through it, so the file surface and the command surface
// cannot disagree about what a path means. The message scope is declared
// before the attachment dir because only the suffix separates the two at
// that depth.
const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'folder', segments: FOLDER }),
  new Scope({ kind: 'day', segments: DAY }),
  new Scope({
    kind: 'message',
    segments: [...DAY, new Slot('message', EMAIL_JSON, 'uid')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({
    kind: 'attachment_dir',
    segments: [...DAY, new Slot('attachment_dir', undefined, 'uid')],
  }),
  new Scope({
    kind: 'attachment',
    segments: [...DAY, new Slot('attachment_dir', undefined, 'uid'), new Slot('filename')],
    leaf: true,
  }),
]

export const detectScope = makeDetectScope(SCOPES)

// Kinds the mailbox search push-down may answer for: one folder or one of
// its days. IMAP search selects a folder, so the mount root cannot push
// down, and a message or attachment names one node.
export const NATIVE_KINDS: ReadonlySet<string> = new Set(['folder', 'day'])
