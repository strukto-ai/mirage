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

const TEAM: readonly (string | Slot)[] = ['teams', new Slot('team', RAW, 'team_id')]
const ISSUE: readonly (string | Slot)[] = [...TEAM, 'issues', new Slot('issue', RAW, 'issue_id')]

// One description of the tree: readdir, stat and read all classify through
// it, so the file surface cannot disagree with itself about what a path
// means. Every dynamic level is a `label__id` name whose id rides in the
// slots (a team's label is itself two-part, `KEY__Name`, which the
// LAST-separator split keeps intact).
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'teams', segments: ['teams'], probed: false }),
  new Scope({ kind: 'team', segments: TEAM }),
  new Scope({
    kind: 'team_json',
    segments: [...TEAM, 'team.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'members', segments: [...TEAM, 'members'] }),
  new Scope({
    kind: 'member',
    segments: [...TEAM, 'members', new Slot('member', JSON_NAME, 'member_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'issues', segments: [...TEAM, 'issues'] }),
  new Scope({ kind: 'issue', segments: ISSUE }),
  new Scope({
    kind: 'issue_json',
    segments: [...ISSUE, 'issue.json'],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({
    kind: 'comments_jsonl',
    segments: [...ISSUE, 'comments.jsonl'],
    leaf: true,
    filetype: ContentType.TEXT,
  }),
  new Scope({ kind: 'projects', segments: [...TEAM, 'projects'] }),
  new Scope({
    kind: 'project',
    segments: [...TEAM, 'projects', new Slot('project', JSON_NAME, 'project_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'cycles', segments: [...TEAM, 'cycles'] }),
  new Scope({
    kind: 'cycle',
    segments: [...TEAM, 'cycles', new Slot('cycle', JSON_NAME, 'cycle_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
  new Scope({ kind: 'documents', segments: [...TEAM, 'documents'] }),
  new Scope({
    kind: 'document',
    segments: [...TEAM, 'documents', new Slot('document', JSON_NAME, 'document_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
]

export const detectScope = makeDetectScope(SCOPES)
