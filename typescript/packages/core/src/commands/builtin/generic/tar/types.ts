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

import type { PathSpec } from '../../../../types.ts'
import type { MemberKind } from '../archive/types.ts'

export type CompressionKind = 'gzip' | 'bzip2' | 'xz'
export type Compression = CompressionKind | null

// One entry the create pass decided to put in the archive. Choosing
// every member before writing any of them is what lets an exclusion
// prune a whole subtree and the ordering stay stable; the writer is then
// a straight loop with no policy left in it.
export interface Member {
  name: string
  kind: MemberKind
  path: PathSpec | null
  target: string
}

// What one `tar -c` pass decided, before anything is written. Notices
// each carry their own `tar: ` prefix and no trailing newline.
export interface CreateResult {
  members: Member[]
  notices: string[]
  exitCode: number
  // Whether to write an archive at all. False for the two refusals GNU
  // makes before reading anything (no operands, and a `-C` it cannot
  // enter), which leave no file behind; an operand it merely failed to
  // stat still writes the rest.
  write: boolean
}
