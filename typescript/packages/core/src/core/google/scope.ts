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
import type { Codec } from '../hierarchy/codec.ts'
import { Slot, Scope } from '../hierarchy/scope.ts'
import { CORPUS } from './constants.ts'

/**
 * The tree of a Google app mount: its corpora and their files. One
 * description per app: readdir, stat, read and unlink all classify through
 * it, so the file surface and the write surface cannot disagree about what a
 * path means. Sheets, Docs and Slides differ only in the codec of a file
 * name. Mirrors Python's `app_scopes`.
 */
export function appScopes(fileName: Codec): readonly Scope[] {
  return [
    new Scope({ kind: 'corpus', segments: [new Slot('corpus', CORPUS)], probed: false }),
    new Scope({
      kind: 'file',
      segments: [new Slot('corpus', CORPUS), new Slot('name', fileName, 'file_id')],
      leaf: true,
      filetype: ContentType.JSON,
    }),
  ]
}
