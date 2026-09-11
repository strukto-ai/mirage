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
import { Slot, Scope, makeDetectScope, type ScopeMatch } from '../hierarchy/scope.ts'
import { KIND_DIR_NAMES, type EntityKind } from './types.ts'

/** Whether the segment names an entity-kind directory. */
export function isKindDir(text: string): boolean {
  return KIND_DIR_NAMES[text] !== undefined
}

export const KIND = new Codec({ validate: isKindDir })

// One description of the tree: readdir, stat, read AND the grep/rg search
// push-down all classify through it, so the file surface and the search
// surface cannot disagree about what a path means.
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'database', segments: [new Slot('database')] }),
  new Scope({
    kind: 'database_json',
    segments: [new Slot('database'), 'database.json'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
  new Scope({
    kind: 'kind_dir',
    segments: [new Slot('database'), new Slot('kind', KIND)],
  }),
  new Scope({
    kind: 'entity',
    segments: [new Slot('database'), new Slot('kind', KIND), new Slot('name')],
  }),
  new Scope({
    kind: 'schema_json',
    segments: [new Slot('database'), new Slot('kind', KIND), new Slot('name'), 'schema.json'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
  new Scope({
    kind: 'documents',
    segments: [new Slot('database'), new Slot('kind', KIND), new Slot('name'), 'documents.jsonl'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
]

export const detectScope = makeDetectScope(SCOPES)

/** The EntityKind a matched scope's kind directory names. */
export function entityKind(match: ScopeMatch): EntityKind {
  const kind = KIND_DIR_NAMES[match.slots.kind ?? '']
  if (kind === undefined) {
    throw new Error(`scope ${match.kind} holds no kind slot`)
  }
  return kind
}
