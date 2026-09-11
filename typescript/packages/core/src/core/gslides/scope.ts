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
import { CORPUS } from '../google/constants.ts'
import { FILE_NAME } from './constants.ts'
import { Slot, Scope, makeDetectScope } from '../hierarchy/scope.ts'

// One description of the tree: readdir, stat, read and unlink all classify
// through it, so the file surface and the write surface cannot disagree
// about what a path means.
export const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'corpus', segments: [new Slot('corpus', CORPUS)], probed: false }),
  new Scope({
    kind: 'file',
    segments: [new Slot('corpus', CORPUS), new Slot('name', FILE_NAME, 'file_id')],
    leaf: true,
    filetype: ContentType.JSON,
  }),
]

export const detectScope = makeDetectScope(SCOPES)
