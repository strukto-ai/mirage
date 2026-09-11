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
import { Codec } from '../hierarchy/codec.ts'
import { Slot, Scope, makeDetectScope } from '../hierarchy/scope.ts'

export const ENTITY_FILES = ['schema.json', 'semantic.json', 'rows.jsonl'] as const

export const KIND_DIRS = ['tables', 'views'] as const

/** Whether the segment names an entity-kind directory. */
export function isKind(text: string): boolean {
  return (KIND_DIRS as readonly string[]).includes(text)
}

export const KIND = new Codec({ validate: isKind })

// One description of the tree: readdir, stat, read AND the grep/rg search
// push-down all classify through it, so the file surface and the search
// surface cannot disagree about what a path means.
export const SCOPES: readonly Scope[] = [
  new Scope({
    kind: 'database_json',
    segments: ['database.json'],
    leaf: true,
    filetype: ContentType.JSON,
    probed: false,
  }),
  new Scope({ kind: 'schema', segments: [new Slot('schema')] }),
  new Scope({ kind: 'kind', segments: [new Slot('schema'), new Slot('kind', KIND)] }),
  new Scope({
    kind: 'entity',
    segments: [new Slot('schema'), new Slot('kind', KIND), new Slot('entity')],
  }),
  new Scope({
    kind: 'entity_schema',
    segments: [new Slot('schema'), new Slot('kind', KIND), new Slot('entity'), 'schema.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({
    kind: 'entity_semantic',
    segments: [new Slot('schema'), new Slot('kind', KIND), new Slot('entity'), 'semantic.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({
    kind: 'entity_rows',
    segments: [new Slot('schema'), new Slot('kind', KIND), new Slot('entity'), 'rows.jsonl'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
]

export const detectScope = makeDetectScope(SCOPES)
