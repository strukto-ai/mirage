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

import { Codec, DATE } from '../hierarchy/codec.ts'
import { makeDetectScope, ROOT, Scope, Slot } from '../hierarchy/scope.ts'
import { ContentType } from '../../types.ts'

export const GMAIL_JSON = new Codec({ suffix: '.gmail.json' })

const LABEL = [new Slot('label')] as const
const DAY = [...LABEL, new Slot('day', DATE)] as const

// One description of the tree: readdir, stat, read and the search push-down
// all classify through it, so the file surface and the command surface
// cannot disagree about what a path means. The message scope is declared
// before the attachment dir because only the suffix separates the two at
// that depth.
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'label', segments: LABEL }),
  new Scope({ kind: 'day', segments: DAY }),
  new Scope({
    kind: 'message',
    segments: [...DAY, new Slot('message', GMAIL_JSON, 'message_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({
    kind: 'attachment_dir',
    segments: [...DAY, new Slot('attachment_dir', undefined, 'message_id')],
  }),
  new Scope({
    kind: 'attachment',
    segments: [...DAY, new Slot('attachment_dir', undefined, 'message_id'), new Slot('filename')],
    leaf: true,
  }),
]

export const detectScope = makeDetectScope(SCOPES)

// Kinds the Gmail search push-down may answer for: the whole account, one
// label, or one label's day. A message file or an attachment names one
// node, which a query over the account cannot stand in for.
export const NATIVE_KINDS: ReadonlySet<string> = new Set([ROOT, 'label', 'day'])
