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

import { ContentType } from '../../types.ts'
import { JSON_NAME, RAW } from '../hierarchy/codec.ts'
import { Scope, Slot, makeDetectScope } from '../hierarchy/scope.ts'

const WS: readonly (string | Slot)[] = ['workspaces', new Slot('workspace', RAW, 'workspace_id')]
const BOARD: readonly (string | Slot)[] = [...WS, 'boards', new Slot('board', RAW, 'board_id')]
const LIST: readonly (string | Slot)[] = [...BOARD, 'lists', new Slot('list', RAW, 'list_id')]
const CARD: readonly (string | Slot)[] = [...LIST, 'cards', new Slot('card', RAW, 'card_id')]

// One description of the tree: readdir, stat and read all classify through
// it, so the file surface cannot disagree with itself about what a path
// means. Every dynamic level is a `label__id` directory whose id rides in
// the slots, which is what lets a reader reach the API without resolving the
// path through the index first.
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'workspaces', segments: ['workspaces'], probed: false }),
  new Scope({ kind: 'workspace', segments: WS }),
  new Scope({
    kind: 'workspace_json',
    segments: [...WS, 'workspace.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'boards', segments: [...WS, 'boards'] }),
  new Scope({ kind: 'board', segments: BOARD }),
  new Scope({
    kind: 'board_json',
    segments: [...BOARD, 'board.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'members', segments: [...BOARD, 'members'] }),
  new Scope({
    kind: 'member',
    segments: [...BOARD, 'members', new Slot('member', JSON_NAME, 'member_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'labels', segments: [...BOARD, 'labels'] }),
  new Scope({
    kind: 'label',
    segments: [...BOARD, 'labels', new Slot('label', JSON_NAME, 'label_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'lists', segments: [...BOARD, 'lists'] }),
  new Scope({ kind: 'list', segments: LIST }),
  new Scope({
    kind: 'list_json',
    segments: [...LIST, 'list.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'cards', segments: [...LIST, 'cards'] }),
  new Scope({ kind: 'card', segments: CARD }),
  new Scope({
    kind: 'card_json',
    segments: [...CARD, 'card.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({
    kind: 'comments_jsonl',
    segments: [...CARD, 'comments.jsonl'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
]

export const detectScope = makeDetectScope(SCOPES)
